import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { all } from 'better-all';
import { z } from 'zod';
import {
	BadRequestError,
	ConflictError,
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
	withAbortSignal,
	withDeadline,
	toPublicNotebookMeta,
	toPublicSource,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal, Project } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { errorMetadataChain, logEvent } from '../log';
import { deleteNotebookAndRetire } from '../routes/notebookDelete';
import {
	assertProjectActionOn,
	assertSessionAccess,
	assertSessionControl,
	assertSessionNotebookVisible,
	loadVisibleProject,
	loadAuthorizedNotebook,
	sessionGrantsFor,
	sessionRetirer,
} from '../shared';
import {
	authorizeSessionStart,
	startNotebookSession,
	toSessionResponse,
} from '../routes/sessionStart';

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

const PROJECT_REFERENCE_DESCRIPTION =
	'Project ID or exact project name (case-insensitive). Use an ID if names are duplicated.';
const NOTEBOOK_REFERENCE_DESCRIPTION =
	'Notebook ID or exact notebook title in the project (case-insensitive). Use an ID if titles are duplicated.';

const NOTEBOOK_CODE_DESCRIPTION =
	'Complete marimo Python notebook source (marimo.App and @app.cell definitions), stored verbatim. Local dependencies come from pyproject.toml; PEP 723 headers are preserved but do not install dependencies.';
const EXPECTED_UPDATED_AT_DESCRIPTION =
	'updated_at returned by get_notebook. Rejects the change if notebook metadata changed since that read.';

class KernelDiscoveryTimeoutError extends Error {
	constructor() {
		super('Kernel session discovery timed out');
		this.name = 'KernelDiscoveryTimeoutError';
	}
}

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
		const response = await withAbortSignal(deps.compute.proxy(request), request.signal);
		return response ?? globalThis.fetch(request);
	};
}

function kernelDiscoveryTimeout(seconds: number): ToolResult {
	return {
		...result({
			code: 'KERNEL_DISCOVERY_TIMEOUT',
			message: `Kernel session discovery exceeded ${seconds} seconds`,
			timedOut: true,
		}),
		isError: true,
	};
}

async function startMcpSession(input: {
	deps: ApiDeps;
	principal: AuthenticatedPrincipal;
	request: StartRequestContext;
	project: Project;
	notebookId: ReturnType<typeof NotebookId.parse>;
	mode: 'edit' | 'app';
	waitSeconds: number;
}): Promise<Record<string, unknown>> {
	const { deps, principal, request, project, notebookId, mode, waitSeconds } = input;
	const started = await startNotebookSession({
		deps,
		user: principal,
		pid: project.id,
		nid: notebookId,
		body: { mode },
		request,
	});
	let session = await deps.services.sessions.getSession(
		project.id,
		SessionId.parse(started.session_id),
	);
	const deadline = Date.now() + waitSeconds * 1000;
	while (session.status === 'starting' && Date.now() < deadline) {
		await sleep(Math.min(2_000, Math.max(0, deadline - Date.now())));
		session = await deps.services.sessions.getSession(project.id, session.session_id);
	}
	const labels = await assertSessionNotebookVisible(deps, project, session, principal);
	const projected = toSessionResponse(
		session,
		await sessionGrantsFor(project, principal, session, deps, labels),
	);
	const notebookUrl = `${request.appBaseUrl}/projects/${project.id}/notebooks/${notebookId}`;
	let execution: { ready: boolean; status: string; next_step: string };
	if (sessionMode(session) !== 'edit') {
		execution = {
			ready: false,
			status: 'app_mode',
			next_step: 'Use start_session with mode="edit" to execute code.',
		};
	} else if (session.status !== 'running') {
		execution = {
			ready: false,
			status: session.status,
			next_step:
				session.status === 'starting'
					? 'Call start_session again to check startup progress.'
					: 'Check the session error before retrying start_session.',
		};
	} else if (!projected.can.attach) {
		execution = {
			ready: false,
			status: 'forbidden',
			next_step: 'Authorize session.attach access before executing code.',
		};
	} else {
		try {
			const kernels = await withDeadline(
				(signal) =>
					listKernelSessions(kernelBaseUrl(session), {
						fetchImpl: kernelFetch(deps),
						kernelAuthToken: session.kernel_auth_token,
						signal,
					}),
				{ timeoutMs: 5_000, timeoutError: () => new KernelDiscoveryTimeoutError() },
			);
			execution =
				kernels.length > 0
					? {
							ready: true,
							status: 'ready',
							next_step: 'Call execute_code with this project_id and session_id.',
						}
					: {
							ready: false,
							status: 'awaiting_client',
							next_step: `Open ${notebookUrl} in a browser to connect a kernel, then retry start_session.`,
						};
		} catch (error) {
			toolError(error, { ...request, userId: principal.id, tool: 'start_session' });
			execution = {
				ready: false,
				status: 'unavailable',
				next_step: 'Kernel readiness could not be checked. Retry start_session for this notebook.',
			};
		}
	}
	return {
		project_id: project.id,
		notebook_id: notebookId,
		session_id: session.session_id,
		status: session.status,
		execution,
		reused: started.reused,
		mode: sessionMode(session),
		notebook_url: `${request.appBaseUrl}/projects/${project.id}/notebooks/${notebookId}`,
		...(projected.sandbox_url ? { sandbox_url: projected.sandbox_url } : {}),
		...(session.error ? { error: session.error } : {}),
	};
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
			description:
				'Discover accessible projects, notebooks, and active sessions. Filter by project, notebook status, tag, or text.',
			annotations: { readOnlyHint: true },
			inputSchema: z.object({
				project: z.string().optional().describe(PROJECT_REFERENCE_DESCRIPTION),
				status: z.enum(NOTEBOOK_STATUSES).optional(),
				tag: z.string().optional(),
				q: z.string().optional(),
				include_sessions: z
					.boolean()
					.default(true)
					.describe(
						'Include sandbox lifecycle statuses. Use start_session to check execution readiness.',
					),
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
						const { notebooks, active } = await all({
							notebooks: async () =>
								deps.services.notebooks.listNotebooks(projectEntry.id, {
									...(status ? { status } : {}),
									...(tag ? { tag } : {}),
									...(q ? { q } : {}),
									subject: principal,
									policy: deps.policy,
									resourceSecurity: deps.resourceSecurity,
								}),
							active: async () =>
								include_sessions ? deps.services.sessions.listActiveByProject(projectEntry.id) : [],
						});
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
		'create_notebook',
		{
			description:
				'Create a local notebook from source. Returns its ID and URL. Use update_notebook to edit an existing notebook.',
			inputSchema: z.object({
				project: z.string().describe(PROJECT_REFERENCE_DESCRIPTION),
				title: z.string().min(1),
				description: z.string().default(''),
				code: z.string().describe(NOTEBOOK_CODE_DESCRIPTION),
				tags: z.array(z.string()).optional(),
				readme: z.string().optional(),
				launch: z
					.boolean()
					.default(false)
					.describe(
						'Start an edit session after creation and return its execution readiness. A browser connection is required for execution.',
					),
			}),
		},
		async ({ project: projectRef, launch, ...notebookInput }) => {
			try {
				const project = await resolveProject(deps, principal, projectRef);
				await assertProjectActionOn(project, principal, 'notebook.write', deps);
				if (launch) await authorizeSessionStart(project, principal, 'edit', deps);
				const notebook = await deps.services.notebooks.createNotebook(
					project.id,
					notebookInput,
					principal.id,
				);
				const notebookData = {
					project_id: project.id,
					notebook_id: notebook.id,
					title: notebook.title,
					status: notebook.status,
					notebook_url: `${request.appBaseUrl}/projects/${project.id}/notebooks/${notebook.id}`,
				};
				if (!launch) return result({ ...notebookData, launched: false });
				const session = await startMcpSession({
					deps,
					principal,
					request,
					project,
					notebookId: notebook.id,
					mode: 'edit',
					waitSeconds: 60,
				});
				return result({ ...notebookData, launched: true, session });
			} catch (error) {
				return errorResult('create_notebook', error);
			}
		},
	);

	server.registerTool(
		'get_notebook',
		{
			description:
				'Read notebook metadata and stored source without a session. Excludes unsaved session edits. Returns updated_at for conditional updates and deletions.',
			annotations: { readOnlyHint: true },
			inputSchema: z.object({
				project: z.string().describe(PROJECT_REFERENCE_DESCRIPTION),
				notebook: z.string().describe(NOTEBOOK_REFERENCE_DESCRIPTION),
			}),
		},
		async ({ project: projectRef, notebook: notebookRef }) => {
			try {
				const project = await resolveProject(deps, principal, projectRef);
				const notebook = await resolveNotebook(deps, principal, project, notebookRef);
				const detail = await loadAuthorizedNotebook(
					deps,
					project,
					notebook.id,
					principal,
					'project.read',
				);
				const code = await deps.services.notebooks.getNotebookContent(project.id, notebook.id);
				return result({
					notebook_id: notebook.id,
					...toPublicNotebookMeta(detail.meta),
					readme: detail.readme,
					source: toPublicSource(detail.source),
					code,
					notebook_url: `${request.appBaseUrl}/projects/${project.id}/notebooks/${notebook.id}`,
				});
			} catch (error) {
				return errorResult('get_notebook', error);
			}
		},
	);

	server.registerTool(
		'update_notebook',
		{
			description:
				'Update stored notebook fields without a session. Omitted fields stay unchanged. Replacing code creates a version and requires a local notebook with no active edit session. Use execute_code for live cell edits.',
			annotations: { destructiveHint: true },
			inputSchema: z.object({
				project: z.string().describe(PROJECT_REFERENCE_DESCRIPTION),
				notebook: z.string().describe(NOTEBOOK_REFERENCE_DESCRIPTION),
				title: z.string().min(1).optional(),
				description: z.string().optional(),
				code: z.string().describe(NOTEBOOK_CODE_DESCRIPTION).optional(),
				tags: z.array(z.string()).optional(),
				readme: z.string().optional(),
				message: z.string().optional().describe('Version message when replacing code.'),
				expected_updated_at: z.string().optional().describe(EXPECTED_UPDATED_AT_DESCRIPTION),
			}),
		},
		async ({ project: projectRef, notebook: notebookRef, expected_updated_at, ...input }) => {
			try {
				const project = await resolveProject(deps, principal, projectRef);
				await assertProjectActionOn(project, principal, 'notebook.write', deps);
				const notebook = await resolveNotebook(deps, principal, project, notebookRef);
				const detail = await loadAuthorizedNotebook(
					deps,
					project,
					notebook.id,
					principal,
					'notebook.write',
				);
				if (
					[input.title, input.description, input.code, input.tags, input.readme].every(
						(value) => value === undefined,
					)
				) {
					throw new BadRequestError(
						'Supply at least one of title, description, code, tags, or readme.',
					);
				}
				if (input.code !== undefined) {
					const editors = (await deps.services.sessions.listActiveByProject(project.id)).filter(
						(session) => session.notebook_id === notebook.id && sessionMode(session) === 'edit',
					);
					if (editors.length > 0) {
						throw new ConflictError(
							`Stop active edit sessions with stop_session before replacing stored code: ${editors.map((session) => session.session_id).join(', ')}. Then call get_notebook and retry update_notebook.`,
						);
					}
				}
				const meta = await deps.services.notebooks.updateNotebook(
					project.id,
					notebook.id,
					input,
					principal.id,
					expected_updated_at ?? detail.meta.updated_at,
				);
				return result({
					notebook_id: notebook.id,
					...toPublicNotebookMeta(meta),
				});
			} catch (error) {
				return errorResult('update_notebook', error);
			}
		},
	);

	server.registerTool(
		'delete_notebook',
		{
			description:
				'Soft-delete a notebook from the catalog. Retires live apps and cancels job runs. No session is required.',
			annotations: { destructiveHint: true, idempotentHint: true },
			inputSchema: z.object({
				project: z.string().describe(PROJECT_REFERENCE_DESCRIPTION),
				notebook: z.string().describe(NOTEBOOK_REFERENCE_DESCRIPTION),
				expected_updated_at: z.string().optional().describe(EXPECTED_UPDATED_AT_DESCRIPTION),
			}),
		},
		async ({ project: projectRef, notebook: notebookRef, expected_updated_at }) => {
			try {
				const project = await resolveProject(deps, principal, projectRef);
				await assertProjectActionOn(project, principal, 'notebook.write', deps);
				const notebook = await resolveNotebook(deps, principal, project, notebookRef);
				await loadAuthorizedNotebook(deps, project, notebook.id, principal, 'notebook.write');
				await deleteNotebookAndRetire(deps, project, notebook.id, principal, expected_updated_at);
				return result({ project_id: project.id, notebook_id: notebook.id, status: 'deleted' });
			} catch (error) {
				return errorResult('delete_notebook', error);
			}
		},
	);

	server.registerTool(
		'start_session',
		{
			description:
				'Start or reuse a notebook session. Returns session_id, notebook_url, and execution readiness. Check execution.ready before execute_code and follow execution.next_step when false. The first start can take about two minutes.',
			inputSchema: z.object({
				project: z.string().describe(PROJECT_REFERENCE_DESCRIPTION),
				notebook: z.string().describe(NOTEBOOK_REFERENCE_DESCRIPTION),
				mode: z
					.enum(['edit', 'app'])
					.default('edit')
					.describe('edit supports scratchpad execution and cell edits; app serves the notebook.'),
				wait_seconds: z.number().int().min(0).max(120).default(60),
			}),
		},
		async ({ project: projectRef, notebook: notebookRef, mode, wait_seconds }) => {
			try {
				const project = await resolveProject(deps, principal, projectRef);
				const notebook = await resolveNotebook(deps, principal, project, notebookRef);
				return result(
					await startMcpSession({
						deps,
						principal,
						request,
						project,
						notebookId: notebook.id,
						mode,
						waitSeconds: wait_seconds,
					}),
				);
			} catch (error) {
				return errorResult('start_session', error);
			}
		},
	);

	server.registerTool(
		'stop_session',
		{
			description:
				'Stop a marimohub session and destroy its sandbox. The stop process attempts to save changes from persistent edit sessions.',
			annotations: { destructiveHint: true, idempotentHint: true },
			inputSchema: z.object({
				project: z.string().describe(PROJECT_REFERENCE_DESCRIPTION),
				session_id: z.string().describe('Session ID returned by start_session or list_catalog.'),
			}),
		},
		async ({ project: projectRef, session_id: sessionId }) => {
			try {
				const project = await resolveProject(deps, principal, projectRef);
				if (!SessionId.is(sessionId)) throw new NotFoundError('Session not found');
				const existing = await deps.services.sessions.getSession(project.id, sessionId);
				const labels = await assertSessionNotebookVisible(deps, project, existing, principal);
				await assertSessionControl(project, existing, principal, deps, labels);
				const { session, transitioned } = await deps.services.sessions.beginTerminating(
					project.id,
					sessionId,
				);
				await sessionRetirer(deps).retire(session, { teardown: transitioned });
				const stopped = await deps.services.sessions.getSession(project.id, sessionId);
				return result({
					project_id: project.id,
					notebook_id: stopped.notebook_id,
					session_id: stopped.session_id,
					status: stopped.status,
				});
			} catch (error) {
				return errorResult('stop_session', error);
			}
		},
	);

	server.registerTool(
		'execute_code',
		{
			description:
				'Run Python in a live edit session with a connected browser kernel. Variables stay live; scratchpad execution does not save notebook cells. For persistent cell edits, inspect `import marimo._code_mode as cm; help(cm)`.',
			inputSchema: z.object({
				project: z.string().describe(PROJECT_REFERENCE_DESCRIPTION),
				session_id: z
					.string()
					.describe('Edit session ID returned by start_session or list_catalog.'),
				code: z
					.string()
					.describe('Python statements to execute in the live scratchpad.')
					.refine(
						(code) => new TextEncoder().encode(code).byteLength <= MAX_EXECUTE_CODE_BYTES,
						`Code exceeds the ${MAX_EXECUTE_CODE_BYTES}-byte limit`,
					),
				timeout_seconds: z.number().int().min(1).max(300).default(60),
			}),
		},
		async (input) => {
			const startedAt = Date.now();
			const deadlineAt = startedAt + input.timeout_seconds * 1000;
			try {
				const project = await resolveProject(deps, principal, input.project);
				if (!SessionId.is(input.session_id)) throw new NotFoundError('Session not found');
				const session = await deps.services.sessions.getSession(project.id, input.session_id);
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
				const kernelRequest = {
					fetchImpl: kernelFetch(deps),
					kernelAuthToken: session.kernel_auth_token,
				};
				const discoveryTimeoutMs = deadlineAt - Date.now();
				if (discoveryTimeoutMs <= 0) return kernelDiscoveryTimeout(input.timeout_seconds);
				let kernelSessions;
				try {
					kernelSessions = await withDeadline(
						(signal) => listKernelSessions(baseUrl, { ...kernelRequest, signal }),
						{
							timeoutMs: discoveryTimeoutMs,
							timeoutError: () => new KernelDiscoveryTimeoutError(),
						},
					);
				} catch (error) {
					if (error instanceof KernelDiscoveryTimeoutError) {
						return kernelDiscoveryTimeout(input.timeout_seconds);
					}
					throw error;
				}
				if (kernelSessions.length === 0) {
					const notebookUrl = `${request.appBaseUrl}/projects/${project.id}/notebooks/${session.notebook_id}`;
					return {
						...result({
							code: 'NO_KERNEL_SESSION',
							message: `No kernel is connected. Open ${notebookUrl} in a browser, then retry execute_code.`,
							notebook_url: notebookUrl,
						}),
						isError: true,
					};
				}
				const kernelSession = kernelSessions[0];
				const executionTimeoutMs = deadlineAt - Date.now();
				if (executionTimeoutMs <= 0) return kernelDiscoveryTimeout(input.timeout_seconds);
				const executed = await executeInKernel(
					baseUrl,
					{
						sessionId: kernelSession.id,
						code: input.code,
						maxStdoutBytes: 256 * 1024,
						maxStderrBytes: 256 * 1024,
						maxOutputBytes: 1024 * 1024,
					},
					{ ...kernelRequest, timeoutMs: executionTimeoutMs },
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
