import {
	bearerToken,
	ForbiddenError,
	HostNotebookId,
	NotFoundError,
	PreconditionFailedError,
	ProjectId,
	SessionId,
	sleep,
	UnavailableError,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import type { HostEvent } from '@marimo-hub/core/host-bridge';
import { sha256Hex } from '@marimo-hub/core/sha256';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { z } from 'zod';
import type { Context } from 'hono';
import type { ApiDeps, HonoEnv } from '../context';
import { refreshIdentity } from '../identity';
import { describeError, logEvent } from '../log';
import {
	assertProjectActionOn,
	authMethodFor,
	initializeForSubject,
	ifMatchToken,
	loadVisibleProject,
} from '../shared';
import { catalogEvents, loadHostNotebook, notebookRecord } from './catalog';
import {
	acceptsEvent,
	errorResponse,
	HostProblemError,
	mapRuntimeEvent,
	mapRuntimeProblem,
	MAX_BODY_BYTES,
	problemResponse,
	RUNTIME_ROUTES,
} from './protocol';
import { HostRetries } from './retries';
import { RuntimeCatalogRefreshes } from './runtimeCatalogRefreshes';
import type { HostMutationReply, HostRetryAttempt } from './retries';
import { callRuntime, ensureHostSession, runtimeDecisions } from './runtime';
import { authorizeMcpSession, sessionAuthorizationDeadline } from '../mcp/sessionActivity';
import { CatalogStream, eventStream } from './streams';

const UpdateNotebook = z.object({
	name: z.string().trim().min(1).max(255),
	path: z.never().optional(),
});
const CreateNotebook = UpdateNotebook.extend({ project_id: z.string() });
const StartRuntime = z.object({ decisions: z.record(z.string(), z.string()).optional() });
const EMPTY_NOTEBOOK =
	'import marimo\n\napp = marimo.App()\n\nif __name__ == "__main__":\n    app.run()\n';

function attachmentHeaders(c: Context<HonoEnv>) {
	return z
		.object({
			identity: z
				.string()
				.min(1)
				.max(128)
				.regex(/^[!-~]+$/)
				.optional(),
			kind: z
				.string()
				.regex(/^[a-z0-9-]+$/)
				.default('client'),
			name: z.string().max(256).nullable(),
		})
		.parse({
			identity: c.req.header('Marimo-Attachment-Identity'),
			kind: c.req.header('Marimo-Attachment-Kind'),
			name: c.req.header('Marimo-Attachment-Name') || null,
		});
}

function upstreamKey(principal: AuthenticatedPrincipal, key: string): string {
	return `${principal.id.length}:${principal.id}:${key}`;
}

function originalRequestId(event: HostEvent, principal: AuthenticatedPrincipal): HostEvent {
	const { request_id: key, ...data } = event.data;
	if (typeof key !== 'string') return event;
	const prefix = upstreamKey(principal, '');
	return {
		...event,
		data: key.startsWith(prefix) ? { ...data, request_id: key.slice(prefix.length) } : data,
	};
}

export function createHostApp(deps: ApiDeps): Hono<HonoEnv> {
	const app = new Hono<HonoEnv>();
	let retries: HostRetries | undefined;
	const runtimeRefreshes = new RuntimeCatalogRefreshes();
	const attachments = new Map<string, HostEvent>();
	const attachmentListeners = new Set<(event: HostEvent, notebookId: string) => void>();
	function publishAttachment(event: HostEvent, notebookId: string) {
		const live = { ...event, id: 'live', data: { ...event.data, time: new Date().toISOString() } };
		for (const listener of attachmentListeners) listener(live, notebookId);
	}
	const runtimes = new Map<HostNotebookId, { sessionId: string; event: HostEvent }>();
	const changes = new Map<string, { key: string; principalId: string; expires: number }>();
	function rememberChange(id: string, key: string, principal: AuthenticatedPrincipal) {
		for (const [notebookId, change] of changes) {
			if (change.expires <= Date.now()) changes.delete(notebookId);
		}
		changes.set(id, { key, principalId: principal.id, expires: Date.now() + 5 * 60_000 });
	}

	async function authenticate(c: Context<HonoEnv>) {
		const user = bearerToken(c.req.raw) ? await deps.authenticator.authenticate(c.req.raw) : null;
		if (!user || authMethodFor(user.credential.kind) !== 'pat')
			throw HostProblemError.unauthorized('A hub bearer token is required');
		if (await deps.services.identities.isSuspended(user.id))
			throw HostProblemError.forbidden('User account is suspended');
		const deadlines = [user.credential.expiresAt, user.entitlementsExpiresAt].filter(
			(value) => value !== undefined,
		);
		if (
			deadlines.some(
				(value) => !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now(),
			)
		)
			throw HostProblemError.unauthorized('Bearer authorization has expired');
		return user;
	}

	app.onError((error) => {
		const response = errorResponse(error);
		if (response.status >= 500)
			logEvent({ level: 'error', event: 'host_request_failed', error: describeError(error) });
		if (response.status === 401)
			response.headers.set('WWW-Authenticate', 'Bearer realm="marimohub-host"');
		return response;
	});
	app.use('*', requestId());
	app.use(
		'*',
		bodyLimit({
			maxSize: MAX_BODY_BYTES,
			onError: () =>
				HostProblemError.payloadTooLarge('Request body exceeds the host API limit').toResponse(),
		}),
	);
	app.use('*', async (c, next) => {
		c.set('deps', deps);
		c.header('Cache-Control', 'no-store');
		const user = await authenticate(c);
		c.set('user', user);
		c.set('authMethod', 'pat');
		await refreshIdentity(c, deps, user);
		if (user.credential.kind !== 'service-account') await initializeForSubject(deps, user);
		if (c.req.method === 'HEAD' && c.req.path.endsWith('/events'))
			return HostProblemError.methodNotAllowed('Use GET to open an event stream').toResponse();
		await next();
	});

	async function mutation(
		c: Context<HonoEnv>,
		work: (key: string, attempt: HostRetryAttempt) => Promise<HostMutationReply>,
		refreshRun = false,
	) {
		const key = c.req.header('Idempotency-Key');
		if (!key || key.length > 256)
			throw HostProblemError.invalidRequest('Idempotency-Key must contain 1–256 characters');
		const fingerprint = await sha256Hex(
			JSON.stringify([
				c.req.method,
				c.req.path,
				c.req.header('If-Match') ?? '',
				await c.req.text(),
			]),
		);
		const result = await (retries ??= new HostRetries(deps.services.hostRetries)).execute(
			c.get('user').id,
			key,
			fingerprint,
			(attempt) => work(key, attempt),
			refreshRun,
			c.req.raw.signal,
		);
		if (
			result.status < 400 &&
			(c.req.method === 'PATCH' || c.req.path.endsWith('/notebooks')) &&
			result.body &&
			typeof result.body === 'object' &&
			'id' in result.body &&
			typeof result.body.id === 'string'
		) {
			const { project, notebook } = await loadHostNotebook(deps, c.get('user'), result.body.id);
			const projected = await notebookRecord(deps, c.get('user'), project, notebook.meta);
			return Response.json(
				{ ...result.body, operations: projected.operations },
				{ status: result.status },
			);
		}
		return result.status >= 400
			? problemResponse(result.body, result.status)
			: Response.json(result.body, { status: result.status });
	}

	function rememberRuntime(events: HostEvent[], notebookId: HostNotebookId, sessionId: string) {
		for (const raw of events) {
			const event = mapRuntimeEvent(raw, notebookId, sessionId);
			if (event.event === 'runtime') runtimes.set(notebookId, { sessionId, event });
			if (event.event === 'runtime.removed') runtimes.delete(notebookId);
		}
	}

	async function appendRuntimes(
		current: HostEvent[],
		visible: ReadonlySet<string>,
		user: AuthenticatedPrincipal,
		signal: AbortSignal,
	) {
		for (const event of current.filter((entry) => entry.event === 'project')) {
			const pid = ProjectId.parse((event.data.project as { id: string }).id);
			const sessions = await deps.services.sessions.listActiveByProject(pid);
			for (const session of sessions) {
				if (session.mode === 'app' || session.status !== 'running') continue;
				const id = HostNotebookId.create(
					pid,
					session.notebook_id,
					session.ephemeral ? session.session_id : undefined,
				);
				if (!visible.has(id)) continue;
				if (deps.compute.connectExisting) {
					try {
						const { project, notebook } = await loadHostNotebook(deps, user, id);
						const decision = await authorizeMcpSession(deps, user, session);
						sessionAuthorizationDeadline(session, user, decision.subjectContextExpiresAt);
						await runtimeRefreshes.refresh(
							session.session_id,
							async (refreshSignal) => {
								try {
									const reply = await callRuntime(
										deps,
										user,
										project,
										notebook,
										session,
										{ method: 'GET', path: '/catalog' },
										refreshSignal,
										false,
									);
									runtimes.delete(id);
									rememberRuntime(reply.events ?? [], id, session.session_id);
								} catch (error) {
									if (
										!(error instanceof UnavailableError) &&
										!(error instanceof HostProblemError && error.status === 409)
									)
										throw error;
									runtimes.delete(id);
								}
							},
							signal,
						);
					} catch {
						signal.throwIfAborted();
					}
				}
			}
			for (const [id, runtime] of runtimes) {
				if (HostNotebookId.parse(id).projectId !== pid) continue;
				const session = sessions.find((entry) => entry.session_id === runtime.sessionId);
				if (session?.status !== 'running') runtimes.delete(id);
				else if (visible.has(id)) {
					try {
						const decision = await authorizeMcpSession(deps, user, session);
						sessionAuthorizationDeadline(session, user, decision.subjectContextExpiresAt);
						current.push(originalRequestId(runtime.event, user));
					} catch {
						signal.throwIfAborted();
					}
				}
			}
		}
	}

	app.get('/events', async (c) => {
		const initial = await catalogEvents(deps, c.get('user'));
		return eventStream(c.req.raw, async (send, signal) => {
			const stream = new CatalogStream(c.req.query('types'));
			const pending: { event: HostEvent; notebookId: string }[] = [];
			const listener = (event: HostEvent, notebookId: string) => {
				if (pending.length < 10_000) pending.push({ event, notebookId });
			};
			attachmentListeners.add(listener);
			try {
				if (c.req.header('Last-Event-ID')) await send({ event: 'reset', data: {} });
				let current = initial;
				let first = true;
				while (!signal.aborted) {
					const ids = new Set(
						current
							.filter((e) => e.event === 'notebook')
							.map((e) => (e.data.notebook as { id: string }).id),
					);
					if (acceptsEvent(c.req.query('types'), 'runtime'))
						await appendRuntimes(current, ids, await authenticate(c), signal);
					for (const attachment of attachments.values()) {
						if (ids.has((attachment.data.attachment as { notebook_id: string }).notebook_id))
							current.push(attachment);
					}
					for (const event of current) {
						if (event.event !== 'notebook') continue;
						const id = (event.data.notebook as { id: string }).id;
						const change = changes.get(id);
						if (!first && change?.principalId === c.get('user').id && change.expires > Date.now())
							event.data.request_id = change.key;
						else if (change && change.expires <= Date.now()) changes.delete(id);
					}
					await stream.update(current, send, first);
					for (const change of pending.splice(0)) {
						if (ids.has(change.notebookId)) await stream.change(change.event, send);
					}
					first = false;
					await sleep(1_000, signal);
					const user = await authenticate(c);
					current = await catalogEvents(deps, user);
				}
			} finally {
				attachmentListeners.delete(listener);
			}
		});
	});

	app.post('/notebooks', async (c) => {
		const input = CreateNotebook.parse(await c.req.json());
		if (!ProjectId.is(input.project_id)) throw HostProblemError.notFound('Project not found');
		const project = await loadVisibleProject(
			deps.services.projects,
			ProjectId.parse(input.project_id),
			c.get('user'),
			deps,
		);
		await assertProjectActionOn(project, c.get('user'), 'notebook.write', deps);
		return mutation(c, async (key, attempt) => {
			await attempt.dispatch();
			const notebook = await deps.services.notebooks.createNotebook(
				project.id,
				{
					title: input.name,
					description: '',
					code: EMPTY_NOTEBOOK,
				},
				c.get('user').id,
			);
			const body = await notebookRecord(deps, c.get('user'), project, notebook);
			rememberChange(body.id, key, c.get('user'));
			return { status: 201, body };
		});
	});

	app.patch('/notebooks/:id', async (c) => {
		const input = UpdateNotebook.parse(await c.req.json());
		const { project, notebook, session } = await loadHostNotebook(
			deps,
			c.get('user'),
			c.req.param('id'),
		);
		if (session) throw new ForbiddenError('Temporary notebooks cannot be renamed');
		await assertProjectActionOn(
			project,
			c.get('user'),
			'notebook.write',
			deps,
			notebook.meta.security_labels ?? null,
		);
		return mutation(c, async (key, attempt) => {
			await attempt.dispatch();
			let updated;
			try {
				updated = await deps.services.notebooks.updateNotebook(
					project.id,
					notebook.meta.id,
					{ title: input.name },
					c.get('user').id,
					ifMatchToken(c),
				);
			} catch (error) {
				if (!(error instanceof PreconditionFailedError)) throw error;
				const response = errorResponse(error);
				return { status: response.status, body: await response.json() };
			}
			const body = await notebookRecord(deps, c.get('user'), project, updated);
			rememberChange(body.id, key, c.get('user'));
			return { status: 200, body };
		});
	});

	async function authorizedRuntime(c: Context<HonoEnv>, operation: string, user = c.get('user')) {
		const context = await loadHostNotebook(deps, user, c.req.param('id')!);
		const record = await notebookRecord(
			deps,
			user,
			context.project,
			context.notebook.meta,
			context.session,
		);
		if (!record.operations.includes(operation))
			throw new ForbiddenError('This credential cannot perform the notebook operation');
		return { ...context, record };
	}

	for (const route of RUNTIME_ROUTES) {
		app.on(route.method, `/notebooks/:id${route.path}`, async (c) => {
			const {
				project,
				notebook,
				session: temporarySession,
			} = await authorizedRuntime(c, route.operation);
			const body: unknown = route.method === 'DELETE' ? undefined : await c.req.json();
			const start = route.operation === 'runtime.start' ? StartRuntime.parse(body) : undefined;
			return mutation(
				c,
				async (key, attempt) => {
					const session = attempt.sessionId
						? await deps.services.sessions
								.getSession(project.id, SessionId.parse(attempt.sessionId))
								.catch((error: unknown) => {
									if (error instanceof NotFoundError)
										throw HostProblemError.noRuntime('The original runtime is no longer available');
									throw error;
								})
						: await ensureHostSession(c, project, notebook, {
								session: temporarySession,
								decisions: start?.decisions,
								key,
							});
					const notebookId = HostNotebookId.create(
						project.id,
						notebook.meta.id,
						session.ephemeral ? session.session_id : undefined,
					);
					if (session.status !== 'running')
						throw HostProblemError.noRuntime('The original runtime is no longer available');
					await attempt.bindSession(session.session_id);
					const reply = await callRuntime(
						deps,
						c.get('user'),
						project,
						notebook,
						session,
						{
							method: route.method,
							path: route.path.replace(':run', encodeURIComponent(c.req.param('run') ?? '')),
							body: start ? { ...start, decisions: runtimeDecisions(start.decisions) } : body,
							headers: {
								'Idempotency-Key': upstreamKey(c.get('user'), key),
								...(c.req.header('If-Match') ? { 'If-Match': c.req.header('If-Match')! } : {}),
							},
						},
						c.req.raw.signal,
					);
					if (reply.status >= 400)
						return { status: reply.status, body: mapRuntimeProblem(reply.body, notebookId) };
					const kind = route.event;
					const mapped = mapRuntimeEvent(
						{ event: kind, data: { [kind]: reply.body } },
						notebookId,
						session.session_id,
					);
					if (kind === 'runtime')
						rememberRuntime(
							[
								{
									event: kind,
									data: { runtime: reply.body, request_id: upstreamKey(c.get('user'), key) },
								},
							],
							notebookId,
							session.session_id,
						);
					return { status: reply.status, body: mapped.data[kind] };
				},
				route.operation === 'runtime.run',
			);
		});
	}

	app.get('/notebooks/:id/events', async (c) => {
		const {
			project,
			notebook,
			record,
			session: temporarySession,
		} = await authorizedRuntime(c, 'runtime.start');
		const metadata = attachmentHeaders(c);
		const runId = c.req.query('run_id');
		if (runId === '') throw HostProblemError.invalidRequest('run_id must not be empty');
		const session = await ensureHostSession(c, project, notebook, { session: temporarySession });
		const path = `/events${runId ? `?run_id=${encodeURIComponent(runId)}` : ''}`;
		const first = await callRuntime(
			deps,
			c.get('user'),
			project,
			notebook,
			session,
			{ method: 'GET', path },
			c.req.raw.signal,
		);
		if (first.status !== 200) return problemResponse(first.body, first.status);
		const attachment = {
			id: crypto.randomUUID(),
			notebook_id: record.id,
			...metadata,
			since: new Date().toISOString(),
		};
		const attachmentEvent: HostEvent = { event: 'attachment', data: { attachment } };
		return eventStream(c.req.raw, async (send, signal) => {
			attachments.set(attachment.id, attachmentEvent);
			publishAttachment(attachmentEvent, record.id);
			const pendingAttachments: HostEvent[] = [];
			const listener = (event: HostEvent, notebookId: string) => {
				if (notebookId === record.id && pendingAttachments.length < 10_000)
					pendingAttachments.push(event);
			};
			attachmentListeners.add(listener);
			let sequence = 0;
			const epoch = crypto.randomUUID();
			const emit = async (event: HostEvent) => {
				if (acceptsEvent(c.req.query('types'), event.event))
					await send({ ...event, ...(event.id ? { id: `${epoch}:${++sequence}` } : {}) });
			};
			let latestNotebook = record;
			const emitSnapshot = async () => {
				const snapshotAttachments = [...attachments.values()].filter(
					(event) => (event.data.attachment as { notebook_id: string }).notebook_id === record.id,
				);
				// The snapshot includes earlier changes; queue only changes after this boundary.
				pendingAttachments.length = 0;
				await emit({ event: 'notebook', data: { notebook: latestNotebook } });
				for (const event of snapshotAttachments) await emit(event);
			};
			let cursor: string | undefined;
			let batch = first;
			let initial = true;
			let previousNotebook = JSON.stringify(record);
			try {
				if (c.req.header('Last-Event-ID')) await emit({ event: 'reset', data: {} });
				await emitSnapshot();
				while (!signal.aborted) {
					if (batch.status !== 200)
						throw HostProblemError.unavailable('Runtime event stream unavailable');
					rememberRuntime(batch.events ?? [], record.id, session.session_id);
					for (const raw of batch.events ?? []) {
						if (raw.id) cursor = raw.id;
						if (
							['notebook', 'attachment', 'attachment.removed', 'host', 'project'].includes(
								raw.event,
							)
						)
							continue;
						if (raw.event === 'ready' && !initial) continue;
						if (raw.event === 'reset') {
							initial = true;
							await emit(raw);
							await emitSnapshot();
							continue;
						}
						await emit(
							originalRequestId(mapRuntimeEvent(raw, record.id, session.session_id), c.get('user')),
						);
						if (raw.event === 'ready') initial = false;
					}
					for (const event of pendingAttachments.splice(0)) await emit(event);
					await sleep(100, signal);
					const user = await authenticate(c);
					const current = await authorizedRuntime(c, 'runtime.start', user);
					const next = current.record;
					latestNotebook = next;
					if (JSON.stringify(next) !== previousNotebook) {
						previousNotebook = JSON.stringify(next);
						await emit({
							event: 'notebook',
							id: 'live',
							data: { notebook: next, time: new Date().toISOString() },
						});
					}
					batch = await callRuntime(
						deps,
						user,
						current.project,
						current.notebook,
						session,
						{
							method: 'GET',
							path,
							headers: cursor ? { 'Last-Event-ID': cursor } : {},
						},
						signal,
					);
				}
			} finally {
				attachmentListeners.delete(listener);
				attachments.delete(attachment.id);
				publishAttachment({ event: 'attachment.removed', data: { id: attachment.id } }, record.id);
			}
		});
	});

	app.all('*', (c) => {
		const path = c.req.path.replace(/^.*\/api\/host\/v1/, '');
		const routes: [RegExp, string[]][] = [
			[/^\/events$/, ['GET']],
			[/^\/notebooks$/, ['POST']],
			[/^\/notebooks\/[^/]+$/, ['PATCH', 'DELETE']],
			[/^\/notebooks\/[^/]+\/events$/, ['GET']],
			[/^\/notebooks\/[^/]+\/(?:edits|save|open|runtime\/restart|runtime\/runs)$/, ['POST']],
			[/^\/notebooks\/[^/]+\/runtime$/, ['PUT', 'DELETE']],
			[/^\/notebooks\/[^/]+\/runtime\/runs\/[^/]+$/, ['DELETE']],
		];
		const methods = routes.find(([pattern]) => pattern.test(path))?.[1];
		if (!methods) return HostProblemError.notFound('Route not found').toResponse();
		if (methods.includes(c.req.method))
			return HostProblemError.unsupportedOperation(
				'This operation is not implemented by the hub host',
			).toResponse();
		const response = HostProblemError.methodNotAllowed(
			'Method not allowed for this route',
		).toResponse();
		response.headers.set('Allow', methods.join(', '));
		return response;
	});
	return app;
}
