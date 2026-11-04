import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { dynamicTool, jsonSchema } from 'ai';
import type { ToolSet, UIMessageChunk } from 'ai';
import { z } from 'zod';
import { CHAT_LIMITS } from '@marimo-hub/core/chat';
import type { ConversationPermission, TurnContext } from '@marimo-hub/core/chat';
import { NotebookId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, Project } from '@marimo-hub/core';
import { ForbiddenError } from '@marimo-hub/core/errors';
import type { ApiDeps } from '../context';
import { DEFAULT_CHAT_CONFIG } from '../context';
import { createMcpServer } from '../mcp/server';
import type { StartRequestContext } from '../mcp/server';
import { loadVisibleProject } from '../shared';
import { assertChatPrincipalCurrent } from './access';
import { checkPermission } from './permissions/gate';
import { oversizedDetail } from './permissions/policies';
import type { GatedTool } from './permissions/policies';
import { boundedOutput, redactSecrets } from './toolPreview';

const TOOL_LIMIT_MESSAGE = 'The tool call budget for this turn is exhausted. Stop and summarize.';

export interface ToolDefinition extends GatedTool {
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
}

export interface ToolSessionState {
	calls: number;
	toolLimit: boolean;
}

export interface BuildToolsInput {
	turn: TurnContext;
	conversationId: string;
	canPrompt: boolean;
	signal: AbortSignal;
	/** Publishes consent cards into the transcript stream. */
	emit(chunk: UIMessageChunk): void;
	/** Called when the model creates a notebook, so the UI can open it beside the chat. */
	onNotebookCreated?(notebookId: NotebookId): Promise<void>;
}

export interface ToolSession {
	definitions: readonly ToolDefinition[];
	readOnlyToolNames: ReadonlySet<string>;
	state: ToolSessionState;
	buildTools(input: BuildToolsInput): ToolSet;
	close(): Promise<void>;
}

/** Inputs that pick a project; the model never sees them and the session fills them in. */
const SCOPE_FIELDS: readonly string[] = ['project', 'project_id'];

function scopeFieldsOf(schema: Record<string, unknown>): string[] {
	const properties = z.record(z.string(), z.unknown()).safeParse(schema.properties);
	const names = properties.success ? Object.keys(properties.data) : [];
	return SCOPE_FIELDS.filter((field) => names.includes(field));
}

function modelSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const properties = z.record(z.string(), z.unknown()).safeParse(schema.properties);
	const visible = Object.fromEntries(
		Object.entries(properties.success ? properties.data : {}).filter(
			([name]) => !SCOPE_FIELDS.includes(name),
		),
	);
	return {
		...schema,
		properties: visible,
		required: Array.isArray(schema.required)
			? schema.required.filter((name) => typeof name !== 'string' || !SCOPE_FIELDS.includes(name))
			: [],
	};
}

function toolFailure(data: Record<string, unknown>): Error {
	const code = typeof data.code === 'string' ? data.code : 'TOOL_FAILED';
	const message = typeof data.message === 'string' ? data.message : 'The tool failed.';
	return new Error(`${code}: ${message}`);
}

/**
 * Connect an in-process MCP server for the principal. Chat gets exactly the
 * tools the hub exposes to any MCP client, under the same authorization, with
 * consent cards added in front of every mutating call.
 */
export async function openToolSession(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	project: Project,
	request: StartRequestContext,
): Promise<ToolSession> {
	const server = createMcpServer(deps, principal, request);
	const client = new Client({ name: 'marimohub-chat', version: '1' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const close = async () => {
		try {
			await client.close();
		} finally {
			await server.close();
		}
	};
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const { tools: exposed } = await client.listTools();
		const definitions: ToolDefinition[] = exposed.map((tool) => ({
			name: tool.name,
			description: tool.description ?? tool.name,
			inputSchema: modelSchema(tool.inputSchema as Record<string, unknown>),
			annotations: tool.annotations,
			readOnly: tool.annotations?.readOnlyHint === true,
		}));
		const scopeFields = new Map(
			exposed.map((tool) => [
				tool.name,
				scopeFieldsOf(tool.inputSchema as Record<string, unknown>),
			]),
		);
		const state: ToolSessionState = { calls: 0, toolLimit: false };
		const timeoutMs =
			(deps.ai?.chat?.taskTimeoutSeconds ?? DEFAULT_CHAT_CONFIG.taskTimeoutSeconds) * 1000;
		return {
			definitions,
			readOnlyToolNames: new Set(definitions.filter((d) => d.readOnly).map((d) => d.name)),
			state,
			close,
			buildTools({ turn, conversationId, canPrompt, signal, emit, onNotebookCreated }) {
				// Mutating tools run one at a time; read-only tools may overlap.
				let mutations: Promise<unknown> = Promise.resolve();
				const serialize = <T>(task: () => Promise<T>): Promise<T> => {
					const next = mutations.then(task, task);
					mutations = next.catch(() => {});
					return next;
				};
				const run = async (
					definition: ToolDefinition,
					toolCallId: string,
					rawInput: unknown,
				): Promise<Record<string, unknown>> => {
					signal.throwIfAborted();
					if (state.calls >= CHAT_LIMITS.toolCallsPerTurn) {
						state.toolLimit = true;
						return { code: 'TOOL_LIMIT', message: TOOL_LIMIT_MESSAGE };
					}
					// Reserve the slot before the first await so parallel calls cannot all
					// pass the check; a refused call hands it back.
					state.calls++;
					const parsed = z.record(z.string(), z.unknown()).safeParse(rawInput ?? {});
					if (!parsed.success) {
						state.calls--;
						return { code: 'INVALID_TOOL_ARGUMENTS', message: 'Tool arguments must be an object' };
					}
					const args = parsed.data;
					const scoped: Record<string, unknown> = { ...args };
					for (const field of scopeFields.get(definition.name) ?? []) {
						const value = args[field];
						if (value !== undefined && value !== project.id && value !== project.name)
							throw new ForbiddenError('Chat tools are scoped to the current project');
						scoped[field] = project.id;
					}
					const oversized = oversizedDetail(definition, args);
					if (oversized) {
						state.calls--;
						return {
							code: 'INPUT_TOO_LARGE',
							message: `${oversized.label} exceeds the ${oversized.limit} characters a user can review before approving. Split the change into smaller steps.`,
						};
					}
					// Only a mutating call can leave the project in an unknown state; a
					// read-only call that never returns is simply repeated next time.
					if (!definition.readOnly)
						await turn.checkpoint({ type: 'tool_started', id: toolCallId, name: definition.name });
					const complete = (result: string, outcome: 'known' | 'uncertain') =>
						turn.checkpoint({
							type: 'tool_completed',
							id: toolCallId,
							name: definition.name,
							result: result.slice(0, 4000),
							outcome,
						});
					const decision = await checkPermission(
						{
							deps,
							principal,
							project,
							conversationId,
							toolCallId,
							canPrompt,
							tool: definition,
							signal,
							record: (permission: ConversationPermission) => {
								emit({ type: 'data-permission', id: permission.id, data: permission });
								return Promise.resolve();
							},
						},
						args,
					);
					if (!decision.allowed) {
						state.calls--;
						const output = { permission: decision.status, message: decision.message };
						await complete(JSON.stringify(output), 'known');
						return output;
					}
					signal.throwIfAborted();
					await assertChatPrincipalCurrent(deps, principal, signal);
					await loadVisibleProject(deps.services.projects, project.id, principal, deps);
					let reply: Awaited<ReturnType<Client['callTool']>>;
					try {
						reply = await client.callTool({ name: definition.name, arguments: scoped }, undefined, {
							signal,
							timeout: timeoutMs,
						});
					} catch (error) {
						if (signal.aborted) throw error;
						// The call may have reached the server; only the server's answer is known.
						await complete(
							'The tool call did not return a result.',
							definition.readOnly ? 'known' : 'uncertain',
						);
						throw new Error(
							'TOOL_FAILED: The tool did not return a result. Inspect the resource before retrying.',
						);
					}
					const content = z.array(z.looseObject({ type: z.string() })).parse(reply.content ?? []);
					const structured = z.record(z.string(), z.unknown()).safeParse(reply.structuredContent);
					const data: Record<string, unknown> = structured.success
						? structured.data
						: {
								content: content
									.filter((block) => block.type === 'text')
									.map((block) => (typeof block.text === 'string' ? block.text : '')),
							};
					const output = boundedOutput(data);
					await complete(JSON.stringify(redactSecrets(output)), 'known');
					if (reply.isError) throw toolFailure(output);
					if (definition.name === 'create_notebook' && onNotebookCreated) {
						const created = z.object({ notebook_id: z.string() }).safeParse(output);
						if (created.success && NotebookId.is(created.data.notebook_id))
							await onNotebookCreated(NotebookId.parse(created.data.notebook_id));
					}
					return output;
				};
				return Object.fromEntries(
					definitions.map((definition) => [
						definition.name,
						dynamicTool({
							description: definition.description,
							inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
							execute: (input, { toolCallId }) =>
								definition.readOnly
									? run(definition, toolCallId, input)
									: serialize(() => run(definition, toolCallId, input)),
						}),
					]),
				);
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}
