import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { routePath } from 'hono/route';
import { z } from 'zod';
import type { Context } from 'hono';
import { sha256Hex, sleep } from './async';
import type { HostEvent } from './events';
import type {
	HostAppOptions,
	HostCatalogSnapshot,
	HostNotebookContext,
	HostNotebookRecord,
	HostPlatform,
	HostPrincipal,
	HostRequestContext,
	HostRuntimeDiscovery,
	HostRuntimeHandle,
} from './platform';
import {
	acceptsEvent,
	CATALOG_KINDS,
	errorResponse,
	HostProblemError,
	mapRuntimeEvent,
	mapRuntimeProblem,
	MAX_BODY_BYTES,
	NOTEBOOK_KINDS,
	parseTypes,
	problemResponse,
	RUNTIME_ROUTES,
	UpstreamProblemError,
} from './protocol';
import type { EventKinds } from './protocol';
import { HostRetries } from './retries';
import type { HostMutationReply, HostRetryAttempt } from './retries';
import { RuntimeCatalogRefreshes } from './runtimeCatalogRefreshes';
import { CatalogStream, eventStream } from './streams';

export type HostAppEnv = { Variables: { requestId: string } };

const NotebookName = z.string().trim().min(1).max(255);
const UpdateNotebook = z.object({ name: NotebookName.optional(), path: z.string().optional() });
const CreateNotebook = z.object({
	project_id: z.string(),
	name: NotebookName,
	path: z.string().optional(),
});
const StartRuntime = z.object({ decisions: z.record(z.string(), z.string()).optional() });
// Permission and runtime changes need not move the catalog version; they are picked up on this cadence.
const CATALOG_REFRESH_MS = 5_000;
// Bearer and notebook access are rechecked on this cadence, or sooner when the catalog moves.
const NOTEBOOK_RECHECK_MS = 30_000;
const CHANGE_CORRELATION_MS = 5 * 60_000;

function attachmentHeaders(c: Context) {
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

function upstreamKey(principal: HostPrincipal, key: string): string {
	return `${principal.id.length}:${principal.id}:${key}`;
}

function originalRequestId(event: HostEvent, principal: HostPrincipal): HostEvent {
	const { request_id: key, ...data } = event.data;
	if (typeof key !== 'string') return event;
	const prefix = upstreamKey(principal, '');
	return {
		...event,
		data: key.startsWith(prefix) ? { ...data, request_id: key.slice(prefix.length) } : data,
	};
}

function upstreamEventsPath(types: EventKinds, runId: string | undefined): string {
	const query = new URLSearchParams();
	// The host publishes notebook and attachment records itself and tracks runtimes from the stream.
	if (types) {
		const kinds = new Set(
			[...types].filter((kind) => kind !== 'notebook' && kind !== 'attachment'),
		);
		kinds.add('runtime');
		query.set('types', [...kinds].join(','));
	}
	if (runId) query.set('run_id', runId);
	const encoded = query.toString();
	return encoded ? `/events?${encoded}` : '/events';
}

function recordId(event: HostEvent, kind: string): string {
	return (event.data[kind] as { id: string }).id;
}

function splitDecisions(decisions: Record<string, string> | undefined, prefix: string | undefined) {
	if (!decisions || !prefix) return { platform: decisions, runtime: decisions };
	const platform: Record<string, string> = {};
	const runtime: Record<string, string> = {};
	for (const [id, choice] of Object.entries(decisions)) {
		(id.startsWith(prefix) ? platform : runtime)[id] = choice;
	}
	return { platform, runtime };
}

export function createHostApp<
	P extends HostPrincipal,
	N extends HostNotebookContext,
	R extends HostRuntimeHandle,
	S extends HostCatalogSnapshot,
>(platform: HostPlatform<P, N, R, S>, options: HostAppOptions = {}): Hono<HostAppEnv> {
	const app = new Hono<HostAppEnv>();
	const challenge = `Bearer realm="${options.realm ?? 'marimo-host'}"`;
	const pollIntervalMs =
		options.pollIntervalMs !== undefined && options.pollIntervalMs >= 1
			? options.pollIntervalMs
			: 1_000;
	const toResponse = (error: unknown) => errorResponse(error, platform.errorStatus?.bind(platform));
	let retries: HostRetries | undefined;
	const runtimeRefreshes = new RuntimeCatalogRefreshes();
	const attachments = new Map<string, HostEvent>();
	const attachmentListeners = new Set<(event: HostEvent, notebookId: string) => void>();
	function publishAttachment(event: HostEvent, notebookId: string) {
		const live = { ...event, id: 'live', data: { ...event.data, time: new Date().toISOString() } };
		for (const listener of attachmentListeners) listener(live, notebookId);
	}
	// Runtime records observed through replies and streams, keyed by notebook ID. Process-local.
	const runtimes = new Map<string, { projectId: string; key: string; event: HostEvent }>();
	const changes = new Map<string, { key: string; principalId: string; expires: number }>();
	function rememberChange(id: string, key: string, principal: P) {
		for (const [notebookId, change] of changes) {
			if (change.expires <= Date.now()) changes.delete(notebookId);
		}
		changes.set(id, {
			key,
			principalId: principal.id,
			expires: Date.now() + CHANGE_CORRELATION_MS,
		});
	}
	const principals = new WeakMap<Request, P>();
	const principalOf = (c: Context<HostAppEnv>): P => principals.get(c.req.raw)!;
	const contextOf = (c: Context<HostAppEnv>): HostRequestContext => ({
		request: c.req.raw,
		requestId: c.get('requestId'),
		signal: c.req.raw.signal,
	});

	app.onError((error, c) => {
		const response = toResponse(error);
		// A client that hung up surfaces as an abort; that is not a host failure.
		if (response.status >= 500 && !c.req.raw.signal.aborted) options.onError?.(error, response);
		if (response.status === 401) response.headers.set('WWW-Authenticate', challenge);
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
		c.header('Cache-Control', 'no-store');
		const principal = await platform.authenticate(c.req.raw);
		principals.set(c.req.raw, principal);
		await platform.onAuthenticated?.(principal, contextOf(c));
		if (c.req.method === 'HEAD' && c.req.path.endsWith('/events'))
			return HostProblemError.methodNotAllowed('Use GET to open an event stream').toResponse();
		await next();
	});

	async function mutation(
		c: Context<HostAppEnv>,
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
		const principal = principalOf(c);
		const result = await (retries ??= new HostRetries(platform.retries, toResponse)).execute(
			principal.id,
			key,
			fingerprint,
			(attempt) => work(key, attempt),
			refreshRun,
			c.req.raw.signal,
		);
		let body = result.body;
		if (
			result.replayed &&
			result.status < 400 &&
			(c.req.method === 'PATCH' || c.req.path.endsWith('/notebooks')) &&
			body &&
			typeof body === 'object' &&
			'id' in body &&
			typeof body.id === 'string'
		) {
			// A stored receipt carries the operations of its first call; permissions may have changed.
			const { record } = await platform.resolveNotebook(principal, body.id);
			body = { ...body, operations: record.operations };
		}
		if (result.status >= 400) {
			const response = problemResponse(body, result.status);
			if (result.status === 401) response.headers.set('WWW-Authenticate', challenge);
			return response;
		}
		return body === undefined
			? new Response(null, { status: result.status })
			: Response.json(body, { status: result.status });
	}

	function rememberRuntime(events: HostEvent[], runtime: HostRuntimeHandle) {
		for (const raw of events) {
			const event = mapRuntimeEvent(raw, runtime.notebookId, runtime.key);
			if (event.event === 'runtime')
				runtimes.set(runtime.notebookId, { projectId: runtime.projectId, key: runtime.key, event });
			if (event.event === 'runtime.removed') runtimes.delete(runtime.notebookId);
		}
	}

	async function discoverRuntime(principal: P, connect: () => Promise<R>, signal: AbortSignal) {
		const runtime = await connect();
		await runtimeRefreshes.refresh(
			runtime.key,
			async (refreshSignal) => {
				try {
					const reply = await platform.callRuntime(
						principal,
						runtime,
						{ method: 'GET', path: '/catalog' },
						refreshSignal,
						{ keepAlive: false },
					);
					runtimes.delete(runtime.notebookId);
					rememberRuntime(reply.events ?? [], runtime);
				} catch (error) {
					const status = toResponse(error).status;
					if (status !== 503 && status !== 409) throw error;
					runtimes.delete(runtime.notebookId);
				}
			},
			signal,
		);
	}

	async function discoverRuntimes(
		visible: ReadonlySet<string>,
		snapshot: S,
		principal: P,
		signal: AbortSignal,
	) {
		const discovered = await platform.runtimes(principal, snapshot, visible, signal);
		await Promise.all(
			discovered.map(async ({ connect, authorized }) => {
				if (!connect || !authorized) return;
				try {
					await discoverRuntime(principal, connect, signal);
				} catch {
					signal.throwIfAborted();
				}
			}),
		);
		return discovered;
	}

	function appendRuntimes(
		current: HostEvent[],
		discovered: readonly HostRuntimeDiscovery<R>[],
		principal: P,
		prune: boolean,
	) {
		const projects = new Set(
			current
				.filter((event) => event.event === 'project')
				.map((event) => recordId(event, 'project')),
		);
		for (const [notebookId, known] of runtimes) {
			if (!projects.has(known.projectId)) continue;
			const match = discovered.find(
				(entry) => entry.key === known.key && entry.notebookId === notebookId,
			);
			if (!match) {
				if (prune) runtimes.delete(notebookId);
			} else if (match.authorized) current.push(originalRequestId(known.event, principal));
		}
	}

	app.get('/events', async (c) => {
		const types = parseTypes(c.req.query('types'), CATALOG_KINDS);
		const requester = principalOf(c);
		let principal = requester;
		let catalog = await platform.catalog(principal, c.req.raw.signal);
		let version = await platform.catalogVersion(principal);
		return eventStream(
			c.req.raw,
			async (send, signal) => {
				const stream = new CatalogStream(types);
				const pending: { event: HostEvent; notebookId: string }[] = [];
				const listener = (event: HostEvent, notebookId: string) => {
					if (pending.length < 10_000) pending.push({ event, notebookId });
				};
				attachmentListeners.add(listener);
				try {
					if (c.req.header('Last-Event-ID')) await send({ event: 'reset', data: {} });
					let first = true;
					let refreshed = Date.now();
					// Discovery re-authorizes every running session, so it follows the catalog cadence.
					let discovered: HostRuntimeDiscovery<R>[] | undefined;
					while (!signal.aborted) {
						const current = catalog.events.map((event) => ({ ...event, data: { ...event.data } }));
						const ids = new Set(
							current.filter((e) => e.event === 'notebook').map((e) => recordId(e, 'notebook')),
						);
						if (acceptsEvent(types, 'runtime')) {
							const fresh = discovered === undefined;
							discovered ??= await discoverRuntimes(ids, catalog, principal, signal);
							appendRuntimes(current, discovered, principal, fresh);
						}
						for (const attachment of attachments.values()) {
							if (ids.has((attachment.data.attachment as { notebook_id: string }).notebook_id))
								current.push(attachment);
						}
						for (const event of current) {
							if (event.event !== 'notebook') continue;
							const id = recordId(event, 'notebook');
							const change = changes.get(id);
							if (!first && change?.principalId === requester.id && change.expires > Date.now())
								event.data.request_id = change.key;
							else if (change && change.expires <= Date.now()) changes.delete(id);
						}
						await stream.update(current, send, first);
						for (const change of pending.splice(0)) {
							if (ids.has(change.notebookId)) await stream.change(change.event, send);
						}
						first = false;
						await sleep(pollIntervalMs, signal);
						principal = await platform.authenticate(c.req.raw);
						const next = await platform.catalogVersion(principal);
						if (next !== version || Date.now() - refreshed >= CATALOG_REFRESH_MS) {
							catalog = await platform.catalog(principal, signal);
							discovered = undefined;
							version = next;
							refreshed = Date.now();
						}
					}
				} finally {
					attachmentListeners.delete(listener);
				}
			},
			toResponse,
		);
	});

	app.post('/notebooks', async (c) => {
		const input = CreateNotebook.parse(await c.req.json());
		const create = await platform.createNotebook(principalOf(c), input, contextOf(c));
		return mutation(c, async (key, attempt) => {
			const record = await create.commit(attempt);
			rememberChange(record.id, key, principalOf(c));
			return { status: 201, body: record };
		});
	});

	app.patch('/notebooks/:id', async (c) => {
		const input = UpdateNotebook.parse(await c.req.json());
		const notebook = await platform.resolveNotebook(principalOf(c), c.req.param('id'));
		const update = await platform.updateNotebook(
			principalOf(c),
			notebook,
			input,
			c.req.header('If-Match'),
			contextOf(c),
		);
		return mutation(c, async (key, attempt) => {
			const record = await update.commit(attempt);
			rememberChange(record.id, key, principalOf(c));
			return { status: 200, body: record };
		});
	});

	async function authorizedNotebook(c: Context<HostAppEnv>, operation: string, principal: P) {
		const notebook = await platform.resolveNotebook(principal, c.req.param('id')!);
		if (!notebook.record.operations.includes(operation))
			throw HostProblemError.forbidden('This credential cannot perform the notebook operation');
		return notebook;
	}

	for (const route of RUNTIME_ROUTES) {
		app.on(route.method, `/notebooks/:id${route.path}`, async (c) => {
			const principal = principalOf(c);
			const notebook = await authorizedNotebook(c, route.operation, principal);
			const body: unknown = route.method === 'DELETE' ? undefined : await c.req.json();
			const start = route.operation === 'runtime.start' ? StartRuntime.parse(body) : undefined;
			const decisions = splitDecisions(start?.decisions, platform.decisionPrefix);
			const params = c.req.param() as Record<string, string | undefined>;
			const path = route.path.replace(/:(run|input)\b/, (_match, name: string) =>
				encodeURIComponent(params[name] ?? ''),
			);
			return mutation(
				c,
				async (key, attempt) => {
					const runtime = attempt.sessionId
						? await platform.runtimeByKey(principal, notebook, attempt.sessionId)
						: route.provision
							? await platform.ensureRuntime(
									principal,
									notebook,
									{ decisions: decisions.platform, key },
									contextOf(c),
								)
							: await platform.existingRuntime(principal, notebook);
					await attempt.bindSession(runtime.key);
					const ifMatch = c.req.header('If-Match');
					const reply = await platform.callRuntime(
						principal,
						runtime,
						{
							method: route.method,
							path,
							body: start ? { ...start, decisions: decisions.runtime } : body,
							headers: {
								'Idempotency-Key': upstreamKey(principal, key),
								...(ifMatch ? { 'If-Match': ifMatch } : {}),
							},
						},
						c.req.raw.signal,
						{ keepAlive: true },
					);
					if (reply.status >= 400)
						return {
							status: reply.status,
							body: mapRuntimeProblem(reply.body, runtime.notebookId),
						};
					const kind = route.event;
					const mapped = mapRuntimeEvent(
						{ event: kind, data: { [kind]: reply.body } },
						runtime.notebookId,
						runtime.key,
					);
					if (kind === 'runtime')
						rememberRuntime(
							[
								{
									event: kind,
									data: { runtime: reply.body, request_id: upstreamKey(principal, key) },
								},
							],
							runtime,
						);
					return { status: reply.status, body: mapped.data[kind] };
				},
				route.operation === 'runtime.run',
			);
		});
	}

	app.get('/notebooks/:id/events', async (c) => {
		const types = parseTypes(c.req.query('types'), NOTEBOOK_KINDS);
		const runId = c.req.query('run_id');
		if (runId === '') throw HostProblemError.invalidRequest('run_id must not be empty');
		const principal = principalOf(c);
		const notebook = await authorizedNotebook(c, 'runtime.start', principal);
		const record = notebook.record;
		const metadata = attachmentHeaders(c);
		const runtime = await platform.ensureRuntime(principal, notebook, {}, contextOf(c));
		const path = upstreamEventsPath(types, runId);
		const call = (user: P, headers: Record<string, string>, signal: AbortSignal) =>
			platform.callRuntime(user, runtime, { method: 'GET', path, headers }, signal, {
				keepAlive: true,
			});
		const first = await call(principal, {}, c.req.raw.signal);
		if (first.status !== 200) {
			const response = problemResponse(mapRuntimeProblem(first.body, record.id), first.status);
			if (first.status === 401) response.headers.set('WWW-Authenticate', challenge);
			return response;
		}
		const attachment = {
			id: crypto.randomUUID(),
			notebook_id: record.id,
			...metadata,
			since: new Date().toISOString(),
		};
		const attachmentEvent: HostEvent = { event: 'attachment', data: { attachment } };
		return eventStream(
			c.req.raw,
			async (send, signal) => {
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
					if (acceptsEvent(types, event.event))
						await send({ ...event, ...(event.id ? { id: `${epoch}:${++sequence}` } : {}) });
				};
				let latestNotebook: HostNotebookRecord = record;
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
				let user = principal;
				let checked = Date.now();
				const recheck = async () => {
					user = await platform.authenticate(c.req.raw);
					latestNotebook = (await authorizedNotebook(c, 'runtime.start', user)).record;
					checked = Date.now();
				};
				try {
					let version = await platform.catalogVersion(user);
					if (c.req.header('Last-Event-ID')) await emit({ event: 'reset', data: {} });
					await emitSnapshot();
					while (!signal.aborted) {
						if (batch.status !== 200)
							throw new UpstreamProblemError(
								batch.status,
								mapRuntimeProblem(batch.body, record.id),
							);
						rememberRuntime(batch.events ?? [], { ...runtime, notebookId: record.id });
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
								await recheck();
								previousNotebook = JSON.stringify(latestNotebook);
								await emit(raw);
								await emitSnapshot();
								continue;
							}
							await emit(originalRequestId(mapRuntimeEvent(raw, record.id, runtime.key), user));
							if (raw.event === 'ready') initial = false;
						}
						for (const event of pendingAttachments.splice(0)) await emit(event);
						await sleep(100, signal);
						const next = await platform.catalogVersion(user);
						if (next !== version || Date.now() - checked >= NOTEBOOK_RECHECK_MS) {
							version = next;
							await recheck();
							if (JSON.stringify(latestNotebook) !== previousNotebook) {
								previousNotebook = JSON.stringify(latestNotebook);
								await emit({
									event: 'notebook',
									id: 'live',
									data: { notebook: latestNotebook, time: new Date().toISOString() },
								});
							}
						}
						batch = await call(user, cursor ? { 'Last-Event-ID': cursor } : {}, signal);
					}
				} finally {
					attachmentListeners.delete(listener);
					attachments.delete(attachment.id);
					publishAttachment(
						{ event: 'attachment.removed', data: { id: attachment.id } },
						record.id,
					);
				}
			},
			toResponse,
		);
	});

	app.all('*', (c) => {
		// The matched pattern carries the mount prefix, so the table below is prefix-independent.
		const base = routePath(c).replace(/\/\*$/, '');
		const path = c.req.path.startsWith(base) ? c.req.path.slice(base.length) : c.req.path;
		const routes: [RegExp, string[]][] = [
			[/^\/events$/, ['GET']],
			[/^\/notebooks$/, ['POST']],
			[/^\/notebooks\/[^/]+$/, ['PATCH', 'DELETE']],
			[/^\/notebooks\/[^/]+\/events$/, ['GET']],
			[/^\/notebooks\/[^/]+\/(?:edits|save|open|runtime\/restart|runtime\/runs)$/, ['POST']],
			[/^\/notebooks\/[^/]+\/runtime$/, ['PUT', 'DELETE']],
			[/^\/notebooks\/[^/]+\/runtime\/runs\/[^/]+$/, ['DELETE']],
			[/^\/notebooks\/[^/]+\/runtime\/inputs\/[^/]+\/reply$/, ['POST']],
		];
		const methods = routes.find(([pattern]) => pattern.test(path))?.[1];
		if (!methods) return HostProblemError.notFound('Route not found').toResponse();
		if (methods.includes(c.req.method))
			return HostProblemError.unsupportedOperation(
				'This operation is not implemented by this host',
			).toResponse();
		const response = HostProblemError.methodNotAllowed(
			'Method not allowed for this route',
		).toResponse();
		response.headers.set('Allow', methods.join(', '));
		return response;
	});
	return app;
}
