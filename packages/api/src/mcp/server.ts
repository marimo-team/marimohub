import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { all } from 'better-all';
import { z } from 'zod';
import {
	BadRequestError,
	NOTEBOOK_STATUSES,
	NotFoundError,
	SessionId,
	sessionMode,
	toPublicJobDefinition,
	toPublicNotebookMeta,
	toPublicSource,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { checkComputeProfile } from '../computeProfile';
import type { ApiDeps } from '../context';
import { withMcpSessionActivity } from './sessionActivity';
import { startMcpSession } from './sessionStartup';
import { executeMcpCode } from './kernelExecution';
import { result, toolError } from './results';
import {
	resolveProject,
	resolveAuthorizedNotebook,
	resolveNotebook,
	PROJECT_REFERENCE_DESCRIPTION,
	NOTEBOOK_REFERENCE_DESCRIPTION,
} from './selectors';
import { registerJobTools } from './jobs';
import { deleteNotebookAndRetire } from '../routes/notebookDelete';
import {
	assertSessionControl,
	assertSessionNotebookVisible,
	loadAuthorizedNotebook,
	sessionRetirer,
} from '../shared';
import { authorizeSessionStart } from '../routes/sessionStart';

export interface StartRequestContext {
	requestId?: string;
	method: string;
	path: string;
	hostname: string;
	appBaseUrl: string;
	signal?: AbortSignal;
}

export const MAX_EXECUTE_CODE_BYTES = 1024 * 1024;

const NOTEBOOK_CODE_DESCRIPTION =
	'Complete marimo Python notebook source (marimo.App and @app.cell definitions), stored verbatim. Declare dependencies in a PEP 723 script header. They install at session or job startup after workspace pyproject.toml dependencies. Dependency changes require a new session. The sandbox image provides marimo.';
const EXPECTED_UPDATED_AT_DESCRIPTION =
	'updated_at returned by get_notebook. Rejects the change if notebook metadata changed since that read.';

export function createMcpServer(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	request: StartRequestContext,
): McpServer {
	const server = new McpServer({ name: 'marimohub', version: deps.version?.version ?? 'dev' });
	const errorResult = (tool: string, error: unknown, signal = request.signal) =>
		toolError(error, { ...request, signal, userId: principal.id, tool });
	const requestSignal = (signal: AbortSignal) =>
		request.signal ? AbortSignal.any([request.signal, signal]) : signal;

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
				compute_profile: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Saved notebook compute profile. Omit for the deployment default. Requires profile selection to be enabled.',
					),
				launch: z
					.boolean()
					.default(false)
					.describe(
						'Start an edit session after creation and initialize its kernel automatically, following notebook automatic-execution settings.',
					),
			}),
		},
		async ({ project: projectRef, launch, ...notebookInput }, extra) => {
			const signal = requestSignal(extra.signal);
			try {
				signal.throwIfAborted();
				const project = await resolveProject(deps, principal, projectRef, 'notebook.write');
				if (launch) await authorizeSessionStart(project, principal, 'edit', deps);
				signal.throwIfAborted();
				const notebook = await deps.services.notebooks.createNotebook(
					project.id,
					{
						...notebookInput,
						compute_profile:
							checkComputeProfile(deps.sandbox, notebookInput.compute_profile) ?? undefined,
					},
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
					request: { ...request, signal },
					project,
					notebookId: notebook.id,
					mode: 'edit',
					waitSeconds: 60,
				});
				return result({ ...notebookData, launched: true, session });
			} catch (error) {
				return errorResult('create_notebook', error, signal);
			}
		},
	);

	server.registerTool(
		'get_notebook',
		{
			description:
				'Read notebook metadata and stored source without a session. Excludes unsaved session edits. Returns updated_at for conditional updates and deletions. Includes saved jobs and their schedules when jobs are enabled.',
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
				// Updates publish the token before content; hold their lease across the reads.
				return await deps.services.notebooks.workspace.withMutation(
					project.id,
					notebook.id,
					{},
					async (lease) => {
						const detail = await loadAuthorizedNotebook(
							deps,
							project,
							notebook.id,
							principal,
							'project.read',
						);
						const { code, jobs } = await all({
							code: async () => deps.services.notebooks.getNotebookContent(project.id, notebook.id),
							jobs: async () =>
								deps.jobs
									? (await deps.services.jobs.listJobs(project.id, notebook.id)).map(
											toPublicJobDefinition,
										)
									: undefined,
						});
						await lease.heartbeat();
						return result({
							notebook_id: notebook.id,
							...toPublicNotebookMeta(detail.meta),
							readme: detail.readme,
							source: toPublicSource(detail.source),
							code,
							...(jobs !== undefined ? { jobs } : {}),
							notebook_url: `${request.appBaseUrl}/projects/${project.id}/notebooks/${notebook.id}`,
						});
					},
				);
			} catch (error) {
				return errorResult('get_notebook', error);
			}
		},
	);

	server.registerTool(
		'update_notebook',
		{
			description:
				'Update stored notebook fields without a session. Omitted fields stay unchanged. Replacing code creates a version and requires a local notebook with no persistent edit session that can still save. Use execute_code for live cell edits.',
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
				const { project, notebook, detail } = await resolveAuthorizedNotebook(
					deps,
					principal,
					projectRef,
					notebookRef,
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
				const { project, notebook } = await resolveAuthorizedNotebook(
					deps,
					principal,
					projectRef,
					notebookRef,
					'notebook.write',
				);
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
				'Start or reuse a notebook session and automatically initialize edit kernels without a browser. Returns session_id, notebook_url, and execution readiness. Check execution.ready before execute_code and follow execution.next_step when false. The first start can take about two minutes.',
			inputSchema: z.object({
				project: z.string().describe(PROJECT_REFERENCE_DESCRIPTION),
				notebook: z.string().describe(NOTEBOOK_REFERENCE_DESCRIPTION),
				mode: z
					.enum(['edit', 'app'])
					.default('edit')
					.describe('edit supports scratchpad execution and cell edits; app serves the notebook.'),
				compute_profile: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Profile for a new persistent edit session. Leaves the saved profile unchanged. Omit for the saved profile, or pass "default" for the deployment default. Reused sessions and restored filesystem snapshots retain their profile.',
					),
				wait_seconds: z
					.number()
					.int()
					.min(0)
					.max(120)
					.default(60)
					.describe(
						'Seconds to wait for sandbox readiness and kernel initialization after startup. Zero only inspects readiness.',
					),
			}),
		},
		async (
			{ project: projectRef, notebook: notebookRef, mode, compute_profile, wait_seconds },
			extra,
		) => {
			const signal = requestSignal(extra.signal);
			try {
				signal.throwIfAborted();
				const project = await resolveProject(
					deps,
					principal,
					projectRef,
					'project.read',
					mode === 'app',
				);
				const notebook = await resolveNotebook(deps, principal, project, notebookRef);
				return result(
					await startMcpSession({
						deps,
						principal,
						request: { ...request, signal },
						project,
						notebookId: notebook.id,
						mode,
						waitSeconds: wait_seconds,
						computeProfile: compute_profile,
					}),
				);
			} catch (error) {
				return errorResult('start_session', error, signal);
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
				'Run Python in a live edit kernel initialized by start_session or a browser. Notebook variables stay live; scratchpad execution does not save notebook cells. For persistent cell edits, inspect `import marimo._code_mode as cm; help(cm)`.',
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
		async (input, extra) => {
			const requestAbortSignal = requestSignal(extra.signal);
			const startedAt = Date.now();
			const deadlineAt = startedAt + input.timeout_seconds * 1000;
			try {
				requestAbortSignal.throwIfAborted();
				const project = await resolveProject(deps, principal, input.project);
				if (!SessionId.is(input.session_id)) throw new NotFoundError('Session not found');
				const session = await deps.services.sessions.getSession(project.id, input.session_id);
				if (session.status !== 'running') throw new BadRequestError('Session is not running');
				if (sessionMode(session) !== 'edit') {
					throw new BadRequestError('Code execution requires an edit session');
				}
				return await withMcpSessionActivity(
					deps,
					principal,
					project,
					session,
					(signal, authorizationDeadline) =>
						executeMcpCode(deps, session, input.code, {
							deadlineAt: Math.min(deadlineAt, authorizationDeadline),
							signal,
							timeoutSeconds: input.timeout_seconds,
							startedAt,
							appBaseUrl: request.appBaseUrl,
						}),
					requestAbortSignal,
				);
			} catch (error) {
				return errorResult('execute_code', error, requestAbortSignal);
			}
		},
	);

	if (deps.jobs) registerJobTools(server, deps, principal, request);
	return server;
}
