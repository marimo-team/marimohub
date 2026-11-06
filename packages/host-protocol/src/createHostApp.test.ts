import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createHostApp } from './createHostApp';
import type { HostEvent, HostReply } from './events';
import { MemoryHostRetryStore } from './memoryRetryStore';
import type {
	HostCatalogSnapshot,
	HostNotebookContext,
	HostNotebookRecord,
	HostPlatform,
	HostRuntimeHandle,
} from './platform';
import { HostProblemError, OPERATIONS, RUNTIME_OPERATIONS } from './protocol';

interface Principal {
	id: string;
}
interface Notebook extends HostNotebookContext {
	stored: { id: string; project_id: string; name: string; updated_at: string };
}
interface Runtime extends HostRuntimeHandle {
	started: number;
}
interface Snapshot extends HostCatalogSnapshot {
	projectIds: string[];
}

const PREFIX = '/hub/host';
const DECISION_PREFIX = 'fake:';

/** A minimal in-memory platform: two users, one project, no sandboxes. */
function fakePlatform() {
	const projects = new Map([['p1', { id: 'p1', name: 'Project' }]]);
	const notebooks = new Map([
		['p1/n1', { id: 'p1/n1', project_id: 'p1', name: 'Notebook', updated_at: '2026-01-01' }],
	]);
	const writers = new Set(['alice']);
	const running = new Map<string, Runtime>();
	let version = 0;
	let runtimeCount = 0;
	const reply = (status: number, body?: unknown, events?: HostEvent[]): HostReply => ({
		status,
		body,
		events,
		notebook: { id: 'local', operations: [] },
	});
	type Platform = HostPlatform<Principal, Notebook, Runtime, Snapshot>;
	const ready: HostEvent = { event: 'ready', data: {} };
	const callRuntime = vi.fn<Platform['callRuntime']>(async (_principal, _runtime, request) =>
		request.method === 'GET' ? reply(200, undefined, [ready]) : reply(200, {}),
	);
	const ensureRuntime = vi.fn<Platform['ensureRuntime']>(async (_principal, notebook) => {
		let runtime = running.get(notebook.record.id);
		if (!runtime) {
			runtime = {
				notebookId: notebook.record.id,
				projectId: notebook.record.project_id,
				key: `rt-${++runtimeCount}`,
				started: Date.now(),
			};
			running.set(notebook.record.id, runtime);
		}
		return runtime;
	});
	function record(principal: Principal, stored: Notebook['stored']): HostNotebookRecord {
		return {
			id: stored.id,
			project_id: stored.project_id,
			path: null,
			name: stored.name,
			updated_at: stored.updated_at,
			operations: writers.has(principal.id) ? ['notebook.update', ...RUNTIME_OPERATIONS] : [],
		};
	}
	const platform: Platform = {
		retries: new MemoryHostRetryStore(),
		decisionPrefix: DECISION_PREFIX,
		async authenticate(request) {
			const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
			if (!token || !['alice', 'bob'].includes(token))
				throw HostProblemError.unauthorized('Unknown token');
			return { id: token };
		},
		async catalog(principal) {
			const events: HostEvent[] = [{ event: 'host', data: { host: { operations: OPERATIONS } } }];
			for (const project of projects.values()) {
				events.push({
					event: 'project',
					data: {
						project: {
							...project,
							root: null,
							status: 'indexed',
							message: null,
							operations: writers.has(principal.id) ? ['notebook.create'] : [],
						},
					},
				});
			}
			for (const stored of notebooks.values())
				events.push({ event: 'notebook', data: { notebook: record(principal, stored) } });
			return { events, projectIds: [...projects.keys()] };
		},
		async catalogVersion() {
			return String(version);
		},
		async runtimes(principal, snapshot, visible) {
			return [...running.values()]
				.filter((runtime) => snapshot.projectIds.includes(runtime.projectId))
				.map((runtime) => ({
					notebookId: runtime.notebookId,
					projectId: runtime.projectId,
					key: runtime.key,
					authorized: visible.has(runtime.notebookId) && writers.has(principal.id),
					connect: async () => runtime,
				}));
		},
		async resolveNotebook(principal, id) {
			const stored = notebooks.get(id);
			if (!stored) throw HostProblemError.notFound('Notebook not found');
			return { stored, record: record(principal, stored) };
		},
		async createNotebook(principal, input) {
			if (!projects.has(input.project_id)) throw HostProblemError.notFound('Project not found');
			if (!writers.has(principal.id)) throw HostProblemError.forbidden('Read-only principal');
			return {
				async commit(attempt) {
					await attempt.dispatch();
					const stored = {
						id: `${input.project_id}/n${notebooks.size + 1}`,
						project_id: input.project_id,
						name: input.name,
						updated_at: new Date().toISOString(),
					};
					notebooks.set(stored.id, stored);
					version++;
					return record(principal, stored);
				},
			};
		},
		async updateNotebook(principal, notebook, input) {
			if (!writers.has(principal.id)) throw HostProblemError.forbidden('Read-only principal');
			if (input.name === undefined) throw HostProblemError.invalidRequest('name is required');
			const name = input.name;
			return {
				async commit(attempt) {
					await attempt.dispatch();
					notebook.stored.name = name;
					version++;
					return record(principal, notebook.stored);
				},
			};
		},
		ensureRuntime,
		async existingRuntime(_principal, notebook) {
			const runtime = running.get(notebook.record.id);
			if (!runtime) throw HostProblemError.noRuntime('No runtime');
			return runtime;
		},
		async runtimeByKey(_principal, notebook, key) {
			const runtime = running.get(notebook.record.id);
			if (runtime?.key !== key) throw HostProblemError.noRuntime('Runtime gone');
			return runtime;
		},
		callRuntime,
	};
	const runtimes = vi.spyOn(platform, 'runtimes');
	const resolveNotebook = vi.spyOn(platform, 'resolveNotebook');
	const onError = vi.fn();
	const app = new Hono().route(PREFIX, createHostApp(platform, { realm: 'fake', onError }));
	const request = (
		method: string,
		path: string,
		options: {
			body?: unknown;
			key?: string;
			as?: string | null;
			headers?: Record<string, string>;
			signal?: AbortSignal;
		} = {},
	) =>
		app.request(`${PREFIX}${path}`, {
			method,
			headers: {
				...(options.as === null ? {} : { Authorization: `Bearer ${options.as ?? 'alice'}` }),
				...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
				...(options.key ? { 'Idempotency-Key': options.key } : {}),
				...options.headers,
			},
			...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
			signal: options.signal,
		});
	return {
		app,
		platform,
		request,
		writers,
		running,
		callRuntime,
		ensureRuntime,
		reply,
		runtimes,
		resolveNotebook,
		onError,
	};
}

/** Reads an open stream without cancelling it, so the stream keeps polling. */
function streamText(response: Response) {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let text = '';
	return {
		get text() {
			return text;
		},
		async until(needle: string) {
			while (!text.includes(needle)) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error(`Stream ended before ${needle}`);
				text += decoder.decode(chunk.value, { stream: true });
			}
		},
		cancel: () => reader.cancel(),
	};
}

async function readUntilReady(response: Response): Promise<HostEvent[]> {
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toContain('text/event-stream');
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let text = '';
	while (!text.includes('event: ready\n')) {
		const chunk = await reader.read();
		if (chunk.done) break;
		text += decoder.decode(chunk.value, { stream: true });
	}
	await reader.cancel();
	return text
		.split('\n\n')
		.filter((block) => block.startsWith('event:') || block.startsWith('id:'))
		.map((block) => {
			const fields = Object.fromEntries(
				block.split('\n').map((line) => {
					const [name, ...rest] = line.split(': ');
					return [name, rest.join(': ')];
				}),
			);
			return {
				event: fields.event,
				id: fields.id,
				data: JSON.parse(fields.data ?? '{}') as Record<string, unknown>,
			};
		});
}

describe('generic host app', () => {
	it('answers the route table independently of the mount prefix', async () => {
		const { request } = fakePlatform();
		const unauthorized = await request('GET', '/events', { as: null });
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get('WWW-Authenticate')).toBe('Bearer realm="fake"');
		expect(await unauthorized.json()).toMatchObject({
			type: 'tag:marimo.io,2026:host/unauthorized',
		});
		expect((await request('HEAD', '/events')).status).toBe(405);
		expect((await request('GET', '/nope')).status).toBe(404);
		const wrongMethod = await request('GET', '/notebooks');
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get('Allow')).toBe('POST');
		expect((await request('DELETE', '/notebooks/p1%2Fn1')).status).toBe(501);
		expect((await request('POST', '/notebooks/p1%2Fn1/open')).status).toBe(501);
	});

	it('streams the catalog snapshot, honours filters, and resets on reconnection', async () => {
		const { request } = fakePlatform();
		const events = await readUntilReady(await request('GET', '/events'));
		expect(events.map((event) => event.event)).toEqual(['host', 'project', 'notebook', 'ready']);
		expect(events[2].data.notebook).toMatchObject({
			id: 'p1/n1',
			operations: ['notebook.update', ...RUNTIME_OPERATIONS],
		});
		expect(events.at(-1)!.id).toMatch(/^[0-9a-f-]+:1$/);
		const filtered = await readUntilReady(
			await request('GET', '/events?types=project', { headers: { 'Last-Event-ID': 'stale' } }),
		);
		expect(filtered.map((event) => event.event)).toEqual(['reset', 'project', 'ready']);
		const readOnly = await readUntilReady(await request('GET', '/events', { as: 'bob' }));
		expect(readOnly[2].data.notebook).toMatchObject({ operations: [] });
		expect((await request('GET', '/events?types=bogus')).status).toBe(400);
	});

	it('creates and renames notebooks under Idempotency-Key semantics', async () => {
		const { request, writers } = fakePlatform();
		const body = { project_id: 'p1', name: 'Fresh' };
		expect((await request('POST', '/notebooks', { body })).status).toBe(400);
		const created = await request('POST', '/notebooks', { body, key: 'k1' });
		expect(created.status).toBe(201);
		const record = (await created.json()) as HostNotebookRecord;
		expect(record).toMatchObject({ id: 'p1/n2', name: 'Fresh', path: null });
		const replay = await request('POST', '/notebooks', { body, key: 'k1' });
		expect(replay.status).toBe(201);
		expect(((await replay.json()) as HostNotebookRecord).id).toBe(record.id);
		const changed = await request('POST', '/notebooks', {
			body: { ...body, name: 'Other' },
			key: 'k1',
		});
		expect(changed.status).toBe(409);
		expect((await request('POST', '/notebooks', { body, key: 'k2', as: 'bob' })).status).toBe(403);
		expect(
			(await request('POST', '/notebooks', { body: { ...body, project_id: 'p9' }, key: 'k3' }))
				.status,
		).toBe(404);

		const renamed = await request('PATCH', `/notebooks/${encodeURIComponent(record.id)}`, {
			body: { name: 'Renamed' },
			key: 'k4',
		});
		expect(renamed.status).toBe(200);
		expect((await renamed.json()) as HostNotebookRecord).toMatchObject({ name: 'Renamed' });
		expect(
			(await request('PATCH', '/notebooks/missing', { body: { name: 'x' }, key: 'k5' })).status,
		).toBe(404);

		// A principal who lost write access cannot replay a stored success.
		writers.delete('alice');
		expect((await request('POST', '/notebooks', { body, key: 'k1' })).status).toBe(403);
	});

	it('does not replay a stored run after the caller loses the operation', async () => {
		const { request, writers, callRuntime } = fakePlatform();
		const run = () =>
			request('POST', '/notebooks/p1%2Fn1/runtime/runs', { body: { cells: ['c1'] }, key: 'run' });
		expect((await run()).status).toBe(200);
		const calls = callRuntime.mock.calls.length;
		writers.delete('alice');
		const replay = await run();
		expect(replay.status).toBe(403);
		expect(await replay.json()).toMatchObject({ type: 'tag:marimo.io,2026:host/forbidden' });
		expect(callRuntime.mock.calls.length).toBe(calls);
	});

	it('reports host failures but not requests the client abandoned', async () => {
		const { request, platform, onError } = fakePlatform();
		const catalog = vi.spyOn(platform, 'catalog').mockRejectedValue(new Error('storage down'));
		expect((await request('GET', '/events')).status).toBe(500);
		expect(onError).toHaveBeenCalledTimes(1);
		const controller = new AbortController();
		catalog.mockImplementation(async () => {
			controller.abort();
			throw new Error('cancelled read');
		});
		expect((await request('GET', '/events', { signal: controller.signal })).status).toBe(500);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it('forwards runtime operations with mapped identifiers and scoped retry keys', async () => {
		const { request, callRuntime, ensureRuntime, reply } = fakePlatform();
		const id = encodeURIComponent('p1/n1');
		callRuntime.mockResolvedValueOnce(
			reply(202, { id: 'kernel', notebook_id: 'local', status: 'starting' }),
		);
		const started = await request('PUT', `/notebooks/${id}/runtime`, {
			body: { decisions: { 'fake:editor': 'takeover', upstream: 'yes' } },
			key: 'start',
		});
		expect(started.status).toBe(202);
		expect(await started.json()).toEqual({
			id: 'rt-1:kernel',
			notebook_id: 'p1/n1',
			status: 'starting',
		});
		expect(ensureRuntime.mock.calls[0][2]).toEqual({
			decisions: { 'fake:editor': 'takeover' },
			key: 'start',
		});
		const [, runtime, forwarded] = callRuntime.mock.calls[0];
		expect(runtime.key).toBe('rt-1');
		expect(forwarded).toMatchObject({
			method: 'PUT',
			path: '/runtime',
			body: { decisions: { upstream: 'yes' } },
			headers: { 'Idempotency-Key': '5:alice:start' },
		});
		callRuntime.mockResolvedValueOnce(reply(202, { id: 'run-1', notebook_id: 'local' }));
		const run = await request('POST', `/notebooks/${id}/runtime/runs`, {
			body: { cells: ['c1'] },
			key: 'run',
		});
		expect(await run.json()).toEqual({ id: 'run-1', notebook_id: 'p1/n1' });
		callRuntime.mockResolvedValueOnce(reply(409, { edit: { document: { notebook_id: 'local' } } }));
		const stale = await request('POST', `/notebooks/${id}/edits`, {
			body: { changes: [] },
			key: 'edit',
			headers: { 'If-Match': 'etag' },
		});
		expect(stale.status).toBe(409);
		expect(stale.headers.get('Content-Type')).toBe('application/problem+json');
		expect(await stale.json()).toEqual({ edit: { document: { notebook_id: 'p1/n1' } } });
		expect(callRuntime.mock.calls.at(-1)![2].headers).toMatchObject({ 'If-Match': 'etag' });
		expect(
			(await request('POST', `/notebooks/${id}/edits`, { body: {}, key: 'e2', as: 'bob' })).status,
		).toBe(403);
	});

	it('answers no-runtime for interrupts without starting anything', async () => {
		const { request, callRuntime, ensureRuntime, reply } = fakePlatform();
		const response = await request('DELETE', '/notebooks/p1%2Fn1/runtime/runs/r1', { key: 'stop' });
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ type: 'tag:marimo.io,2026:host/no-runtime' });
		expect(callRuntime).not.toHaveBeenCalled();
		expect(ensureRuntime).not.toHaveBeenCalled();

		callRuntime.mockResolvedValueOnce(reply(202, { id: 'kernel', notebook_id: 'local' }));
		await request('PUT', '/notebooks/p1%2Fn1/runtime', { body: {}, key: 'start' });
		callRuntime.mockResolvedValueOnce(reply(204));
		const stopped = await request('DELETE', '/notebooks/p1%2Fn1/runtime/runs/r1', { key: 'stop2' });
		expect(stopped.status).toBe(204);
		expect(await stopped.text()).toBe('');
	});

	it('serves the notebook stream with the platform record, attachments, and mapped runtime events', async () => {
		const { request, callRuntime, reply } = fakePlatform();
		callRuntime.mockResolvedValueOnce(
			reply(200, undefined, [
				{ event: 'runtime', id: 'u1', data: { runtime: { id: 'kernel', notebook_id: 'local' } } },
				{
					event: 'cell',
					id: 'u2',
					data: { cell: { id: 'c1', notebook_id: 'local' }, request_id: '5:alice:edit' },
				},
				{ event: 'ready', data: {} },
			]),
		);
		const events = await readUntilReady(
			await request('GET', '/notebooks/p1%2Fn1/events', {
				headers: { 'Marimo-Attachment-Name': 'Tests' },
			}),
		);
		expect(events.map((event) => event.event)).toEqual([
			'notebook',
			'attachment',
			'runtime',
			'cell',
			'ready',
		]);
		expect(events[1].data.attachment).toMatchObject({ notebook_id: 'p1/n1', name: 'Tests' });
		expect(events[2].data.runtime).toEqual({ id: 'rt-1:kernel', notebook_id: 'p1/n1' });
		expect(events[3].data).toEqual({
			cell: { id: 'c1', notebook_id: 'p1/n1' },
			request_id: 'edit',
		});
		expect(callRuntime.mock.calls[0][2]).toMatchObject({ method: 'GET', path: '/events' });
		// Platform-published kinds are served locally; the runtime still reports its runtime records.
		const filtered = await readUntilReady(
			await request('GET', '/notebooks/p1%2Fn1/events?types=cell,notebook'),
		);
		expect(filtered.map((event) => event.event)).toEqual(['notebook', 'ready']);
		expect(callRuntime.mock.calls.at(-1)![2]).toMatchObject({
			path: '/events?types=cell%2Cruntime',
		});
		expect((await request('GET', '/notebooks/p1%2Fn1/events', { as: 'bob' })).status).toBe(403);
		callRuntime.mockResolvedValueOnce(reply(401, { type: 'x', detail: 'runtime token expired' }));
		const rejected = await request('GET', '/notebooks/p1%2Fn1/events');
		expect(rejected.status).toBe(401);
		expect(rejected.headers.get('WWW-Authenticate')).toBe('Bearer realm="fake"');
		callRuntime
			.mockResolvedValueOnce(reply(200, undefined, [{ event: 'ready', data: {} }]))
			.mockResolvedValueOnce(
				reply(409, { type: 'x', edit: { document: { notebook_id: 'local' } } }),
			);
		const failed = await request('GET', '/notebooks/p1%2Fn1/events');
		const text = await failed.text();
		expect(text).toContain('event: effect/httpapi/stream/failure');
		expect(text).toContain('"type":"x"');
		expect(text).toContain('"notebook_id":"p1/n1"');
	});

	it('lists discovered runtimes in the catalog only for principals who may see them', async () => {
		const { request, callRuntime, reply } = fakePlatform();
		callRuntime.mockResolvedValueOnce(reply(202, { id: 'kernel', notebook_id: 'local' }));
		expect(
			(await request('PUT', '/notebooks/p1%2Fn1/runtime', { body: {}, key: 'start' })).status,
		).toBe(202);
		callRuntime.mockImplementation(async (_principal, _runtime, forwarded) =>
			forwarded.path === '/catalog'
				? reply(200, undefined, [
						{
							event: 'runtime',
							data: { runtime: { id: 'kernel', notebook_id: 'local', status: 'idle' } },
						},
					])
				: reply(200, undefined, []),
		);
		const events = await readUntilReady(await request('GET', '/events?types=runtime'));
		expect(events.map((event) => event.event)).toEqual(['runtime', 'ready']);
		expect(events[0].data.runtime).toEqual({
			id: 'rt-1:kernel',
			notebook_id: 'p1/n1',
			status: 'idle',
		});
		expect(events[0].data.request_id).toBeUndefined();
		expect(callRuntime.mock.calls.at(-1)![3]).toBeInstanceOf(AbortSignal);
		const probes = callRuntime.mock.calls.length;
		const hidden = await readUntilReady(
			await request('GET', '/events?types=runtime', { as: 'bob' }),
		);
		expect(hidden.map((event) => event.event)).toEqual(['ready']);
		expect(callRuntime.mock.calls.length).toBe(probes);
	});

	it('discovers runtimes when the catalog is recomputed, not on every tick', async () => {
		const { request, runtimes } = fakePlatform();
		await request('PUT', '/notebooks/p1%2Fn1/runtime', { body: {}, key: 'start' });
		const stream = streamText(await request('GET', '/events?types=runtime'));
		try {
			await stream.until('event: ready\n');
			await new Promise((resolve) => setTimeout(resolve, 1_300));
			expect(runtimes).toHaveBeenCalledTimes(1);
			// A catalog move recomputes the snapshot and its runtime discovery.
			await request('PATCH', '/notebooks/p1%2Fn1', { body: { name: 'Moved' }, key: 'rename' });
			await vi.waitFor(() => expect(runtimes).toHaveBeenCalledTimes(2), { timeout: 2_000 });
		} finally {
			await stream.cancel();
		}
	});

	it('rechecks notebook access when the catalog moves rather than on every poll', async () => {
		const { request, callRuntime, resolveNotebook } = fakePlatform();
		const stream = streamText(await request('GET', '/notebooks/p1%2Fn1/events'));
		try {
			await stream.until('event: ready\n');
			const resolved = resolveNotebook.mock.calls.length;
			const polls = callRuntime.mock.calls.length;
			await vi.waitFor(() => expect(callRuntime.mock.calls.length).toBeGreaterThan(polls + 2));
			expect(resolveNotebook.mock.calls.length).toBe(resolved);
			await request('PATCH', '/notebooks/p1%2Fn1', { body: { name: 'Renamed' }, key: 'rename' });
			await stream.until('"name":"Renamed"');
			expect(resolveNotebook.mock.calls.length).toBeGreaterThan(resolved);
		} finally {
			await stream.cancel();
		}
	});

	it('tells catalog subscribers when a notebook stream client disconnects', async () => {
		const { request } = fakePlatform();
		const catalog = streamText(await request('GET', '/events?types=attachment'));
		try {
			await catalog.until('event: ready\n');
			const notebook = streamText(await request('GET', '/notebooks/p1%2Fn1/events'));
			await notebook.until('event: ready\n');
			await catalog.until('event: attachment\n');
			const attachment = /"attachment":\{"id":"([^"]+)"/.exec(catalog.text)![1];
			await notebook.cancel();
			await catalog.until('event: attachment.removed\n');
			expect(catalog.text.split('event: attachment.removed\n')[1]).toContain(attachment);
		} finally {
			await catalog.cancel();
		}
	});
});
