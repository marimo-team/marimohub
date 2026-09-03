import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
	BadRequestError,
	DomainError,
	executeInKernel,
	foldCase,
	kernelBaseUrl,
	listKernelSessions,
	NOTEBOOK_STATUSES,
	NotFoundError,
	NotebookId,
	ProjectId,
	SessionId,
	sessionMode,
	sleep,
	workspaceSourcePolicy,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal, Project, Session } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { errorMetadataChain, logEvent } from '../log';
import {
	assertSessionAccess,
	assertSessionNotebookVisible,
	loadVisibleProject,
	sessionGrantsFor,
} from '../shared';
import { startNotebookSession, toSessionResponse } from '../routes/sessionStart';

export interface StartRequestContext {
	requestId?: string;
	method: string;
	path: string;
	hostname: string;
	appBaseUrl: string;
}

type ToolResult = {
	content: { type: 'text'; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

export const MAX_EXECUTE_CODE_BYTES = 1024 * 1024;

function result(data: Record<string, unknown>, text = JSON.stringify(data, null, 2)): ToolResult {
	return { content: [{ type: 'text', text }], structuredContent: data };
}

function toolError(
	error: unknown,
	context: StartRequestContext & { userId: string; tool: string },
): ToolResult {
	if (!(error instanceof DomainError)) {
		logEvent({
			level: 'error',
			event: 'mcp_tool_error',
			request_id: context.requestId ?? null,
			method: context.method,
			path: context.path,
			user: context.userId,
			tool: context.tool,
			error: errorMetadataChain(error),
		});
	}
	const data =
		error instanceof DomainError
			? { code: error.code, message: error.message }
			: { code: 'INTERNAL_ERROR', message: 'Internal error' };
	return { ...result(data), isError: true };
}

async function resolveProject(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	value: string,
): Promise<Project> {
	if (ProjectId.is(value)) {
		return loadVisibleProject(deps.services.projects, value, principal, deps);
	}
	const projects = await deps.services.projects.listProjects({
		subject: principal,
		policy: deps.policy,
		resourceSecurity: deps.resourceSecurity,
	});
	const matches = projects.filter((project) => foldCase(project.name) === foldCase(value));
	if (matches.length === 0) throw new NotFoundError(`Project '${value}' not found`);
	if (matches.length > 1) {
		throw new BadRequestError(
			`Project name '${value}' is ambiguous; use one of: ${matches.map((item) => item.id).join(', ')}`,
		);
	}
	return loadVisibleProject(deps.services.projects, matches[0].id, principal, deps);
}

async function resolveNotebook(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	project: Project,
	value: string,
) {
	const notebooks = await deps.services.notebooks.listNotebooks(project.id, {
		subject: principal,
		policy: deps.policy,
		resourceSecurity: deps.resourceSecurity,
	});
	if (NotebookId.is(value)) {
		const match = notebooks.find((notebook) => notebook.id === value);
		if (!match) throw new NotFoundError(`Notebook ${value} not found`);
		return match;
	}
	const matches = notebooks.filter((notebook) => foldCase(notebook.title) === foldCase(value));
	if (matches.length === 0) throw new NotFoundError(`Notebook '${value}' not found`);
	if (matches.length > 1) {
		throw new BadRequestError(
			`Notebook title '${value}' is ambiguous; use one of: ${matches.map((item) => item.id).join(', ')}`,
		);
	}
	return matches[0];
}

function kernelFetch(deps: ApiDeps): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		return (await deps.compute.proxy(request)) ?? globalThis.fetch(request);
	};
}

function newestFirst(left: Session, right: Session): number {
	return Date.parse(right.last_heartbeat) - Date.parse(left.last_heartbeat);
}

export function createMcpServer(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	request: StartRequestContext,
): McpServer {
	const server = new McpServer({ name: 'marimohub', version: deps.version?.version ?? 'dev' });
	const errorResult = (tool: string, error: unknown) =>
		toolError(error, { ...request, userId: principal.id, tool });

	server.registerTool(
		'list_catalog',
		{
			description: 'List the projects and notebooks visible to the current marimohub user.',
			inputSchema: z.object({
				project: z.string().optional(),
				status: z.enum(NOTEBOOK_STATUSES).optional(),
				tag: z.string().optional(),
				q: z.string().optional(),
				include_sessions: z.boolean().default(true),
			}),
		},
		async ({ project, status, tag, q, include_sessions }) => {
			try {
				const projects = project
					? [await resolveProject(deps, principal, project)]
					: await deps.services.projects.listProjects({
							subject: principal,
							policy: deps.policy,
							resourceSecurity: deps.resourceSecurity,
						});
				const entries = await Promise.all(
					projects.map(async (projectEntry) => {
						const notebooks = await deps.services.notebooks.listNotebooks(projectEntry.id, {
							...(status ? { status } : {}),
							...(tag ? { tag } : {}),
							...(q ? { q } : {}),
							subject: principal,
							policy: deps.policy,
							resourceSecurity: deps.resourceSecurity,
						});
						const active = include_sessions
							? await deps.services.sessions.listActiveByProject(projectEntry.id)
							: [];
						return {
							id: projectEntry.id,
							name: projectEntry.name,
							notebooks: notebooks.map((notebook) => ({
								id: notebook.id,
								title: notebook.title,
								status: notebook.status,
								tags: notebook.tags,
								updated_at: notebook.updated_at,
								url: `${request.appBaseUrl}/projects/${projectEntry.id}/notebooks/${notebook.id}`,
								...(include_sessions
									? {
											sessions: active
												.filter((session) => session.notebook_id === notebook.id)
												.map((session) => ({
													id: session.session_id,
													mode: sessionMode(session),
													status: session.status,
												})),
										}
									: {}),
							})),
						};
					}),
				);
				return result({ projects: entries });
			} catch (error) {
				return errorResult('list_catalog', error);
			}
		},
	);

	server.registerTool(
		'launch_notebook',
		{
			description:
				'Create or reuse a marimohub notebook session. A first launch can take about two minutes; calling again attaches to the same session.',
			inputSchema: z.object({
				project: z.string(),
				notebook: z.string(),
				mode: z.enum(['edit', 'app']).default('edit'),
				wait_seconds: z.number().int().min(0).max(120).default(60),
			}),
		},
		async ({ project: projectRef, notebook: notebookRef, mode, wait_seconds }) => {
			try {
				const project = await resolveProject(deps, principal, projectRef);
				const notebook = await resolveNotebook(deps, principal, project, notebookRef);
				const started = await startNotebookSession({
					deps,
					user: principal,
					pid: project.id,
					nid: notebook.id,
					body: { mode },
					request,
				});
				let session = await deps.services.sessions.getSession(
					project.id,
					SessionId.parse(started.session_id),
				);
				const deadline = Date.now() + wait_seconds * 1000;
				while (session.status === 'starting' && Date.now() < deadline) {
					await sleep(Math.min(2_000, Math.max(0, deadline - Date.now())));
					session = await deps.services.sessions.getSession(project.id, session.session_id);
				}
				const labels = await assertSessionNotebookVisible(deps, project, session, principal);
				const projected = toSessionResponse(
					session,
					await sessionGrantsFor(project, principal, session, deps, labels),
				);
				return result({
					project_id: project.id,
					notebook_id: notebook.id,
					session_id: session.session_id,
					status: session.status,
					reused: started.reused,
					mode: sessionMode(session),
					notebook_url: `${request.appBaseUrl}/projects/${project.id}/notebooks/${notebook.id}`,
					...(projected.sandbox_url ? { sandbox_url: projected.sandbox_url } : {}),
					...(session.error ? { error: session.error } : {}),
				});
			} catch (error) {
				return errorResult('launch_notebook', error);
			}
		},
	);

	server.registerTool(
		'execute_code',
		{
			description:
				"Run code in an edit notebook's live scratchpad. Variables stay live. For durable cell edits, run `import marimo._code_mode as cm; help(cm)` first. A browser tab must be connected to the notebook.",
			inputSchema: z
				.object({
					project: z.string(),
					session_id: z.string().optional(),
					notebook: z.string().optional(),
					code: z
						.string()
						.refine(
							(code) => new TextEncoder().encode(code).byteLength <= MAX_EXECUTE_CODE_BYTES,
							`Code exceeds the ${MAX_EXECUTE_CODE_BYTES}-byte limit`,
						),
					timeout_seconds: z.number().int().min(1).max(300).default(60),
					kernel_session_id: z.string().optional(),
				})
				.refine((input) => Boolean(input.session_id) !== Boolean(input.notebook), {
					message: 'Provide exactly one of session_id or notebook',
				}),
		},
		async (input) => {
			const startedAt = Date.now();
			try {
				const project = await resolveProject(deps, principal, input.project);
				let session: Session;
				if (input.session_id) {
					if (!SessionId.is(input.session_id)) throw new NotFoundError('Session not found');
					session = await deps.services.sessions.getSession(project.id, input.session_id);
				} else {
					const notebook = await resolveNotebook(deps, principal, project, input.notebook!);
					const editorClaim = await deps.services.sessions.getEditorClaim(project.id, notebook.id);
					const candidates = (await deps.services.sessions.listActiveByProject(project.id))
						.filter(
							(candidate) =>
								candidate.notebook_id === notebook.id &&
								candidate.status === 'running' &&
								sessionMode(candidate) === 'edit',
						)
						.sort((left, right) => {
							const own =
								Number(right.user_id === principal.id) - Number(left.user_id === principal.id);
							const claimed =
								Number(right.session_id === editorClaim?.session_id) -
								Number(left.session_id === editorClaim?.session_id);
							return own || claimed || newestFirst(left, right);
						});
					if (!candidates[0]) throw new NotFoundError('No running edit session was found');
					session = candidates[0];
				}
				if (session.status !== 'running') throw new BadRequestError('Session is not running');
				if (sessionMode(session) !== 'edit') {
					throw new BadRequestError('Code execution requires an edit session');
				}
				if (
					session.authorization_expires_at &&
					Date.now() >= Date.parse(session.authorization_expires_at)
				) {
					throw new BadRequestError('Session authorization has expired');
				}
				const labels = await assertSessionNotebookVisible(deps, project, session, principal);
				await assertSessionAccess(project, session, principal, deps, labels);
				const baseUrl = kernelBaseUrl(session);
				const kernelSessions = await listKernelSessions(baseUrl, { fetchImpl: kernelFetch(deps) });
				if (kernelSessions.length === 0) {
					const notebookUrl = `${request.appBaseUrl}/projects/${project.id}/notebooks/${session.notebook_id}`;
					return {
						...result({
							code: 'NO_KERNEL_SESSION',
							message: `No browser tab is connected; open ${notebookUrl} then retry`,
						}),
						isError: true,
					};
				}
				const notebook = await deps.services.notebooks.getNotebook(project.id, session.notebook_id);
				const entryName = workspaceSourcePolicy(notebook.source).entryNotebook.split('/').at(-1);
				const kernelSession = input.kernel_session_id
					? kernelSessions.find((candidate) => candidate.id === input.kernel_session_id)
					: (kernelSessions.find((candidate) => candidate.path?.split('/').at(-1) === entryName) ??
						kernelSessions[0]);
				if (!kernelSession) throw new NotFoundError('Kernel session not found');
				const executed = await executeInKernel(
					baseUrl,
					{
						sessionId: kernelSession.id,
						code: input.code,
						maxStdoutBytes: 256 * 1024,
						maxStderrBytes: 256 * 1024,
						maxOutputBytes: 1024 * 1024,
					},
					{ fetchImpl: kernelFetch(deps), timeoutMs: input.timeout_seconds * 1000 },
				);
				const data = {
					project_id: project.id,
					notebook_id: session.notebook_id,
					session_id: session.session_id,
					kernel_session_id: kernelSession.id,
					...executed,
					duration_ms: Date.now() - startedAt,
				};
				const text = [
					executed.stdout,
					executed.stderr ? `stderr:\n${executed.stderr}` : '',
					executed.output
						? `${executed.output.mimetype}:\n${typeof executed.output.data === 'string' ? executed.output.data : JSON.stringify(executed.output.data)}`
						: '',
					executed.timedOut ? 'TIMED OUT' : executed.success ? 'success' : 'FAILED',
				]
					.filter(Boolean)
					.join('\n\n');
				return {
					...result(data, text),
					...(!executed.completed || !executed.success ? { isError: true } : {}),
				};
			} catch (error) {
				return errorResult('execute_code', error);
			}
		},
	);

	return server;
}
