import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createServices,
	HostNotebookId,
	NotebookId,
	NotFoundError,
	ProjectId,
	SandboxId,
	SessionId,
	SessionRetirer,
	UnavailableError,
	UserId,
} from '@marimo-hub/core';
import { makeFakeCompute, makeFsSandbox } from '@marimo-hub/core/testing';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import type { HostEvent, HostReply } from '@marimo-hub/core/host-bridge';
import { requestRuntimeHost } from '@marimo-hub/core/host-bridge';
import { createApi } from '../createApi';
import type { ApiDeps } from '../context';
import { createInitializedBucket, makeTestDeps } from '../testing';
import { HOST_PREFIX } from './protocol';
import type { HostDecision } from './protocol';

vi.mock('@marimo-hub/core/host-bridge', () => ({ requestRuntimeHost: vi.fn() }));
const user: AuthenticatedPrincipal = {
	id: UserId.parse('host-user'),
	email: 'host@example.com',
	credential: { kind: 'personal-access-token', id: 'host-token' },
};
afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(requestRuntimeHost).mockReset();
});

function runtimeReply(reply: Omit<HostReply, 'notebook'>): HostReply {
	return { notebook: { id: 'local', operations: [] }, ...reply };
}

async function setup(policy: ApiDeps['policy'] = {}) {
	const bucket = await createInitializedBucket();
	let principal: AuthenticatedPrincipal | null = user;
	const deps = makeTestDeps(bucket, {
		authenticator: { authenticate: async () => principal },
		compute: makeFakeCompute(),
		policy,
	});
	const project = await deps.services.projects.createProject(
		{ name: 'Host project', description: '' },
		user.id,
	);
	const notebook = await deps.services.notebooks.createNotebook(
		project.id,
		{ title: 'Notebook', description: '', code: 'import marimo\napp = marimo.App()\n' },
		user.id,
	);
	const app = createApi(deps);
	const id = HostNotebookId.create(project.id, notebook.id);
	function request(
		method: string,
		path: string,
		body?: unknown,
		key?: string,
		extra: Record<string, string> = {},
	) {
		return app.request(`${HOST_PREFIX}${path}`, {
			method,
			headers: {
				Authorization: 'Bearer test',
				...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
				...(key ? { 'Idempotency-Key': key } : {}),
				...extra,
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
	}
	async function runtime() {
		const created = await deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: notebook.id,
			user_id: user.id,
			sandbox_id: SandboxId.create(),
			mode: 'edit',
			editor_sandbox_sharing: policy.editorSandboxSharing ?? 'shared',
		});
		await deps.services.sessions.claimEditor(
			project.id,
			notebook.id,
			created.session_id,
			policy.editorSandboxSharing ?? 'shared',
			user.id,
		);
		return deps.services.sessions.setRunning(
			project.id,
			created.session_id,
			'https://sandbox.example',
		);
	}
	return {
		app,
		deps,
		project,
		notebook,
		id,
		request,
		runtime,
		setUser: (value: typeof principal) => {
			principal = value;
		},
	};
}

async function readSnapshot(response: Response) {
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
		.filter((block) => block.includes('event: '))
		.map((block) => ({
			event: /^event: (.+)$/m.exec(block)![1],
			id: /^id: (.+)$/m.exec(block)?.[1],
			data: JSON.parse(/^data: (.+)$/m.exec(block)![1]),
		})) as HostEvent[];
}

describe('hub host protocol', () => {
	it('returns a protocol 404 for malformed notebook IDs without starting compute', async () => {
		const { request, deps, id, project } = await setup();
		const compute = vi.spyOn(deps.compute, 'create');
		const update = vi.spyOn(deps.services.notebooks, 'updateNotebook');
		for (const invalid of ['invalid', project.id, `${id}:extra`, `${id}\n`, `${id}\0`, `${id}:`]) {
			const path = `/notebooks/${encodeURIComponent(invalid)}`;
			const responses = [
				await request('GET', `${path}/events`),
				await request('PUT', `${path}/runtime`, {}, 'invalid-start'),
				await request('PATCH', path, { name: 'Renamed' }, 'invalid-update'),
			];
			for (const response of responses) {
				expect(response.status).toBe(404);
				expect(response.headers.get('content-type')).toBe('application/problem+json');
				expect(await response.json()).toMatchObject({ status: 404, detail: 'Notebook not found' });
			}
		}
		expect(compute).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(requestRuntimeHost).not.toHaveBeenCalled();
	});

	it('rejects missing resources and notebooks paired with the wrong project', async () => {
		const { request, deps, project, notebook } = await setup();
		const other = await deps.services.projects.createProject(
			{ name: 'Other project', description: '' },
			user.id,
		);
		const compute = vi.spyOn(deps.compute, 'create');
		const update = vi.spyOn(deps.services.notebooks, 'updateNotebook');
		for (const id of [
			HostNotebookId.create(ProjectId.create(), notebook.id),
			HostNotebookId.create(project.id, NotebookId.create()),
			HostNotebookId.create(other.id, notebook.id),
		]) {
			for (const response of [
				await request('PUT', `/notebooks/${id}/runtime`, {}, `start-${id}`),
				await request('PATCH', `/notebooks/${id}`, { name: 'Wrong project' }, `rename-${id}`),
			]) {
				expect(response.status).toBe(404);
				expect(await response.json()).toMatchObject({
					type: 'tag:marimo.io,2026:host/not-found',
					status: 404,
				});
			}
		}
		expect(compute).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(requestRuntimeHost).not.toHaveBeenCalled();
	});

	it.each([
		['PUT', '/runtime'],
		['POST', '/edits'],
		['POST', '/save'],
		['POST', '/runtime/runs'],
		['DELETE', '/runtime/runs/run-1'],
		['GET', '/events'],
	])('denies read-only credentials on %s %s before starting compute', async (method, suffix) => {
		const { request, deps, project, id, setUser } = await setup();
		setUser({
			...user,
			credential: {
				...user.credential,
				grant: { actions: ['project.read'], projects: [project.id] },
			},
		});
		const compute = vi.spyOn(deps.compute, 'create');
		const response = await request(
			method,
			`/notebooks/${id}${suffix}`,
			method === 'GET' || method === 'DELETE' ? undefined : {},
			'denied',
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			type: 'tag:marimo.io,2026:host/forbidden',
			status: 403,
		});
		expect(compute).not.toHaveBeenCalled();
		expect(requestRuntimeHost).not.toHaveBeenCalled();
	});

	it('rejects invalid JSON and runtime options without starting compute', async () => {
		const { request, app, deps, id } = await setup();
		const compute = vi.spyOn(deps.compute, 'create');
		const malformed = await app.request(`${HOST_PREFIX}/notebooks/${id}/runtime`, {
			method: 'PUT',
			headers: {
				Authorization: 'Bearer test',
				'Content-Type': 'application/json',
				'Idempotency-Key': 'malformed',
			},
			body: '{',
		});
		const invalid = await request('PUT', `/notebooks/${id}/runtime`, { decisions: [] }, 'invalid');
		for (const response of [malformed, invalid]) {
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				type: 'tag:marimo.io,2026:host/invalid-request',
				status: 400,
			});
		}
		expect(compute).not.toHaveBeenCalled();
		expect(requestRuntimeHost).not.toHaveBeenCalled();
	});

	it('can retry the same mutation after a runtime transport failure', async () => {
		const { request, id, runtime } = await setup();
		await runtime();
		const bridge = vi
			.mocked(requestRuntimeHost)
			.mockRejectedValueOnce(new UnavailableError('private runtime detail'))
			.mockResolvedValueOnce(
				runtimeReply({
					status: 202,
					body: { id: 'kernel', notebook_id: 'local', status: 'starting' },
				}),
			);
		const failed = await request('PUT', `/notebooks/${id}/runtime`, {}, 'retry');
		expect(failed.status).toBe(503);
		expect(failed.headers.get('content-type')).toBe('application/problem+json');
		expect(await failed.json()).toEqual({
			type: 'tag:marimo.io,2026:host/unavailable',
			title: 'unavailable',
			status: 503,
			detail: 'The host could not complete the request',
		});
		expect((await request('PUT', `/notebooks/${id}/runtime`, {}, 'retry')).status).toBe(202);
		expect(bridge).toHaveBeenCalledTimes(2);
		expect(bridge.mock.calls[0][1].headers).toEqual(bridge.mock.calls[1][1].headers);
	});

	it('does not persist a rejected save and permits retry with the same key', async () => {
		const { request, deps, id, runtime, project, notebook } = await setup();
		await runtime();
		const original = await deps.services.notebooks.getNotebookContent(project.id, notebook.id);
		const { instance } = makeFsSandbox({ files: { 'notebook.py': 'saved after retry' } });
		vi.spyOn(deps.compute, 'create').mockReturnValue(instance);
		const bridge = vi
			.mocked(requestRuntimeHost)
			.mockResolvedValueOnce(
				runtimeReply({
					status: 409,
					body: { type: 'tag:marimo.io,2026:host/conflict', status: 409 },
				}),
			)
			.mockResolvedValueOnce(
				runtimeReply({
					status: 200,
					body: { document: { notebook_id: 'local', saved_etag: 'saved' }, cells: {} },
				}),
			);
		expect((await request('POST', `/notebooks/${id}/save`, {}, 'save-retry')).status).toBe(409);
		expect(await deps.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
			original,
		);
		expect((await request('POST', `/notebooks/${id}/save`, {}, 'save-retry')).status).toBe(200);
		expect(await deps.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
			'saved after retry',
		);
		expect(bridge).toHaveBeenCalledTimes(2);
	});

	it('does not persist a save when editor ownership is lost during the runtime request', async () => {
		const { request, deps, id, runtime, project, notebook } = await setup();
		const session = await runtime();
		const original = await deps.services.notebooks.getNotebookContent(project.id, notebook.id);
		const { instance } = makeFsSandbox({ files: { 'notebook.py': 'stale editor content' } });
		vi.spyOn(deps.compute, 'create').mockReturnValue(instance);
		vi.mocked(requestRuntimeHost).mockImplementationOnce(async () => {
			await deps.services.sessions.releaseEditorFor(session);
			await runtime();
			return runtimeReply({
				status: 200,
				body: { document: { notebook_id: 'local', saved_etag: 'saved' }, cells: {} },
			});
		});
		const response = await request('POST', `/notebooks/${id}/save`, {}, 'lost-claim');
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			type: 'tag:marimo.io,2026:host/conflict',
			detail: 'The session no longer owns the notebook editor',
		});
		expect(await deps.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
			original,
		);
	});

	it('requires bearer credential provenance and returns protocol problems', async () => {
		const { app, request, setUser } = await setup();
		const missing = await app.request(`${HOST_PREFIX}/events`);
		expect(missing.status).toBe(401);
		expect(missing.headers.get('content-type')).toBe('application/problem+json');
		expect(await missing.json()).toMatchObject({
			type: 'tag:marimo.io,2026:host/unauthorized',
			status: 401,
		});
		setUser({ ...user, credential: { kind: 'sso' } });
		expect((await request('GET', '/events')).status).toBe(401);
	});

	it('serves permission-filtered catalog snapshots without compute and resets cursors', async () => {
		const { request, deps, id, project } = await setup();
		const compute = vi.spyOn(deps.compute, 'create');
		const snapshot = await readSnapshot(
			await request('GET', '/events', undefined, undefined, { 'Last-Event-ID': 'expired' }),
		);
		expect(snapshot[0].event).toBe('reset');
		expect(snapshot[1]).toMatchObject({ event: 'host', id: undefined });
		expect(snapshot.find((event) => event.event === 'project')).toMatchObject({
			data: { project: { id: project.id, root: null, operations: ['notebook.create'] } },
		});
		expect(snapshot.find((event) => event.event === 'notebook')).toMatchObject({
			data: {
				notebook: {
					id,
					path: null,
					operations: expect.arrayContaining([
						'runtime.start',
						'notebook.edit',
						'notebook.save',
						'runtime.run',
						'runtime.interrupt',
					]),
				},
			},
		});
		expect(snapshot.at(-1)).toMatchObject({ event: 'ready', id: expect.any(String) });
		expect(compute).not.toHaveBeenCalled();
		expect(vi.mocked(requestRuntimeHost)).not.toHaveBeenCalled();
	});

	it('filters stream kinds but always sends ready', async () => {
		const { request } = await setup();
		const events = await readSnapshot(await request('GET', '/events?types=project'));
		expect(events.map((event) => event.event)).toEqual(['project', 'ready']);
	});

	it('deduplicates concurrent creates and rejects cross-route key reuse', async () => {
		const { request, deps, project, id } = await setup();
		const create = vi.spyOn(deps.services.notebooks, 'createNotebook');
		const responses = await Promise.all([
			request('POST', '/notebooks', { project_id: project.id, name: 'Created' }, 'same'),
			request('POST', '/notebooks', { project_id: project.id, name: 'Created' }, 'same'),
		]);
		expect(responses.map((response) => response.status)).toEqual([201, 201]);
		const [first, second] = await Promise.all(responses.map((response) => response.json()));
		expect(first).toEqual(second);
		expect(create).toHaveBeenCalledTimes(1);
		expect((await request('PATCH', `/notebooks/${id}`, { name: 'Renamed' }, 'same')).status).toBe(
			409,
		);
		expect(
			(await request('POST', '/notebooks', { project_id: project.id, name: 'No key' })).status,
		).toBe(400);
	});

	it('deduplicates a burst across independent API instances and a subsequent restart', async () => {
		const { app, deps, project } = await setup();
		const secondDeps = { ...deps, services: createServices(deps.bucket) };
		const second = createApi(secondDeps);
		const creates = [
			vi.spyOn(deps.services.notebooks, 'createNotebook'),
			vi.spyOn(secondDeps.services.notebooks, 'createNotebook'),
		];
		const send = async (target: typeof app, name = 'Burst') =>
			target.request(`${HOST_PREFIX}/notebooks`, {
				method: 'POST',
				headers: {
					Authorization: 'Bearer test',
					'Content-Type': 'application/json',
					'Idempotency-Key': 'cross-replica',
				},
				body: JSON.stringify({ project_id: project.id, name }),
			});
		const responses = await Promise.all(
			Array.from({ length: 32 }, (_, index) => send(index % 2 ? second : app)),
		);
		expect(responses.every((response) => response.status === 201)).toBe(true);
		const notebooks = await Promise.all(
			responses.map((response) => response.json() as Promise<{ id: string }>),
		);
		expect(new Set(notebooks.map((notebook) => notebook.id)).size).toBe(1);
		expect(creates.reduce((total, spy) => total + spy.mock.calls.length, 0)).toBe(1);
		const restarted = createApi({ ...deps, services: createServices(deps.bucket) });
		expect(await (await send(restarted)).json()).toEqual(notebooks[0]);
		expect((await send(restarted, 'Different')).status).toBe(409);
	});

	it('serves authenticated catalog SSE without CORS when MCP OAuth is enabled', async () => {
		const { deps } = await setup();
		const app = createApi({ ...deps, mcp: { publicBaseUrl: 'https://hub.example.com' } });
		const response = await app.request(`${HOST_PREFIX}/events?types=host,project,notebook`, {
			headers: { Authorization: 'Bearer test', Origin: 'https://client.example' },
		});
		expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
		expect((await readSnapshot(response)).at(-1)?.event).toBe('ready');
	});

	it('renames while preserving identity and rejects filesystem paths', async () => {
		const { request, id, project } = await setup();
		const response = await request('PATCH', `/notebooks/${id}`, { name: 'Renamed' }, 'rename');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id, name: 'Renamed', path: null });
		expect(
			(
				await request(
					'POST',
					'/notebooks',
					{ project_id: project.id, name: 'Bad', path: '../bad.py' },
					'path',
				)
			).status,
		).toBe(400);
		expect((await request('DELETE', `/notebooks/${id}`, undefined, 'delete')).status).toBe(501);
	});

	it('checks normalized rename preconditions and preserves a newer title after stale writes', async () => {
		const { request, id, notebook, deps, project } = await setup();
		const rename = await request('PATCH', `/notebooks/${id}`, { name: 'Newer' }, 'rename-match', {
			'If-Match': `"${notebook.updated_at}"`,
		});
		expect(rename.status).toBe(200);
		const stale = await request('PATCH', `/notebooks/${id}`, { name: 'Stale' }, 'rename-stale', {
			'If-Match': `"${notebook.updated_at}"`,
		});
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ type: 'tag:marimo.io,2026:host/conflict' });
		expect((await deps.services.notebooks.getNotebook(project.id, notebook.id)).meta.title).toBe(
			'Newer',
		);
		expect(
			(
				await request('PATCH', `/notebooks/${id}`, { name: 'Any' }, 'rename-stale', {
					'If-Match': '*',
				})
			).status,
		).toBe(200);
	});

	it('shares catalog runtime refreshes while rechecking permissions for cached records', async () => {
		const { request, deps, runtime, id, project, setUser } = await setup();
		await runtime();
		deps.compute.connectExisting = vi.fn(() => makeFsSandbox().instance);
		const bridge = vi.mocked(requestRuntimeHost).mockResolvedValue(
			runtimeReply({
				status: 200,
				events: [{ event: 'runtime', data: { runtime: { id: 'kernel', notebook_id: 'local' } } }],
			}),
		);
		const snapshots = await Promise.all(
			Array.from({ length: 3 }, async () =>
				readSnapshot(await request('GET', '/events?types=runtime')),
			),
		);
		for (const snapshot of snapshots)
			expect(snapshot[0]).toMatchObject({
				event: 'runtime',
				data: { runtime: { notebook_id: id } },
			});
		expect(bridge).toHaveBeenCalledTimes(1);
		await readSnapshot(await request('GET', '/events?types=runtime'));
		expect(bridge).toHaveBeenCalledTimes(1);
		setUser({
			...user,
			credential: {
				...user.credential,
				grant: { actions: ['project.read'], projects: [project.id] },
			},
		});
		expect(
			(await readSnapshot(await request('GET', '/events?types=runtime'))).map(
				(event) => event.event,
			),
		).toEqual(['ready']);
		expect(bridge).toHaveBeenCalledTimes(1);
		setUser(user);
		expect((await readSnapshot(await request('GET', '/events?types=runtime')))[0].event).toBe(
			'runtime',
		);
		expect(bridge).toHaveBeenCalledTimes(1);
	});

	it('only correlates catalog changes with the principal who submitted the mutation', async () => {
		const { request, deps, id, project, setUser } = await setup();
		await deps.services.projects.addMember(
			project.id,
			{ user_id: otherUser.id },
			'editor',
			user.id,
		);
		const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
		const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, needle: string) => {
			let text = '';
			while (!text.includes(needle)) {
				const next = await reader.read();
				if (next.done) throw new Error('Stream ended before expected event');
				text += new TextDecoder().decode(next.value);
			}
			return text;
		};
		try {
			readers.push((await request('GET', '/events?types=notebook')).body!.getReader());
			await readUntil(readers[0], 'event: ready');
			setUser(otherUser);
			readers.push((await request('GET', '/events?types=notebook')).body!.getReader());
			await readUntil(readers[1], 'event: ready');
			setUser(user);
			expect(
				(await request('PATCH', `/notebooks/${id}`, { name: 'Renamed' }, 'private-key')).status,
			).toBe(200);
			const [own, other] = await Promise.all(readers.map((reader) => readUntil(reader, 'Renamed')));
			expect(own).toContain('"request_id":"private-key"');
			expect(other).not.toContain('private-key');
		} finally {
			await Promise.all(readers.map((reader) => reader.cancel()));
		}
	});

	it('omits other principals request IDs from shared runtime and notebook events', async () => {
		const { request, deps, id, project, runtime, setUser } = await setup();
		await runtime();
		await deps.services.projects.addMember(
			project.id,
			{ user_id: otherUser.id },
			'editor',
			user.id,
		);
		vi.mocked(requestRuntimeHost).mockResolvedValue(
			runtimeReply({
				status: 200,
				events: [
					{
						event: 'runtime',
						data: {
							runtime: { id: 'kernel', notebook_id: 'local' },
							request_id: `${user.id.length}:${user.id}:private-runtime-key`,
						},
					},
					{ event: 'ready', data: {} },
				],
			}),
		);
		const own = await readSnapshot(await request('GET', `/notebooks/${id}/events`));
		expect(own.find((event) => event.event === 'runtime')?.data.request_id).toBe(
			'private-runtime-key',
		);
		setUser(otherUser);
		const other = await readSnapshot(await request('GET', `/notebooks/${id}/events`));
		expect(other.find((event) => event.event === 'runtime')?.data).not.toHaveProperty('request_id');
		deps.compute.connectExisting = undefined;
		const catalog = await readSnapshot(await request('GET', '/events?types=runtime'));
		expect(catalog[0].event).toBe('runtime');
		expect(catalog[0].data).not.toHaveProperty('request_id');
	});

	it('rejects idempotency-key reuse with changed edit content or preconditions', async () => {
		const { request, id, runtime } = await setup();
		await runtime();
		const bridge = vi.mocked(requestRuntimeHost).mockResolvedValue(
			runtimeReply({
				status: 200,
				body: { document: { notebook_id: 'local', etag: 'updated' }, cells: {} },
			}),
		);
		const edit = { changes: [{ kind: 'put_cell', cell: { id: 'c1', code: 'x = 1' } }] };
		expect(
			(
				await request('POST', `/notebooks/${id}/edits`, edit, 'edit-key', {
					'If-Match': 'original',
				})
			).status,
		).toBe(200);
		for (const response of [
			await request('POST', `/notebooks/${id}/edits`, { changes: [] }, 'edit-key', {
				'If-Match': 'original',
			}),
			await request('POST', `/notebooks/${id}/edits`, edit, 'edit-key', { 'If-Match': 'changed' }),
		]) {
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				type: 'tag:marimo.io,2026:host/conflict',
				detail: 'Idempotency-Key was used for a different request',
			});
		}
		expect(bridge).toHaveBeenCalledTimes(1);
	});

	it('rechecks authorization before replay and hides inaccessible notebooks', async () => {
		const { request, project, id, setUser } = await setup();
		expect(
			(await request('POST', '/notebooks', { project_id: project.id, name: 'Created' }, 'key'))
				.status,
		).toBe(201);
		setUser({
			...user,
			credential: {
				...user.credential,
				grant: { actions: ['project.read'], projects: [project.id] },
			},
		});
		expect(
			(await request('POST', '/notebooks', { project_id: project.id, name: 'Created' }, 'key'))
				.status,
		).toBe(403);
		const events = await readSnapshot(await request('GET', '/events'));
		expect(events.find((event) => event.event === 'notebook')).toMatchObject({
			data: { notebook: { operations: [] } },
		});
		setUser({ ...user, id: UserId.parse('outsider') });
		expect(
			(await request('PATCH', `/notebooks/${id}`, { name: 'Invisible' }, 'other')).status,
		).toBe(404);
	});

	it('delegates to the shared editor, maps identities, and passes edit preconditions', async () => {
		const { request, id, runtime } = await setup();
		const session = await runtime();
		const bridge = vi.mocked(requestRuntimeHost);
		bridge.mockResolvedValueOnce(
			runtimeReply({
				status: 202,
				body: { id: 'kernel', notebook_id: 'local', status: 'starting' },
			}),
		);
		const start = await request('PUT', `/notebooks/${id}/runtime`, {}, 'start');
		expect(start.status).toBe(202);
		expect(await start.json()).toMatchObject({
			id: `${session.session_id}:kernel`,
			notebook_id: id,
		});
		bridge.mockResolvedValueOnce(
			runtimeReply({
				status: 200,
				body: { document: { notebook_id: 'local', etag: 'new' }, cells: { c1: { version: 2 } } },
			}),
		);
		const edit = {
			changes: [{ kind: 'put_cell', cell: { id: 'c1', code: 'x = 1' }, etag: 'old' }],
		};
		const response = await request('POST', `/notebooks/${id}/edits`, edit, 'edit');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ document: { notebook_id: id, etag: 'new' } });
		expect(bridge.mock.calls.at(-1)?.[1]).toMatchObject({
			path: '/edits',
			body: edit,
			headers: { 'Idempotency-Key': `${user.id.length}:${user.id}:edit` },
		});
	});

	it('launches a sandbox on demand and reuses it for later runtime requests', async () => {
		const { request, deps, id, project } = await setup();
		vi.mocked(requestRuntimeHost).mockResolvedValue(
			runtimeReply({
				status: 202,
				body: { id: 'kernel', notebook_id: 'local', status: 'starting' },
			}),
		);
		expect((await request('PUT', `/notebooks/${id}/runtime`, {}, 'first')).status).toBe(202);
		expect((await request('PUT', `/notebooks/${id}/runtime`, {}, 'second')).status).toBe(202);
		expect(await deps.services.sessions.listActiveByProject(project.id)).toHaveLength(1);
	});

	it('saves through the runtime and commits the sandbox file to hub storage', async () => {
		const { request, deps, id, runtime, project, notebook } = await setup();
		await runtime();
		const { instance } = makeFsSandbox({ files: { 'notebook.py': 'saved source' } });
		vi.spyOn(deps.compute, 'create').mockReturnValue(instance);
		vi.mocked(requestRuntimeHost).mockResolvedValue(
			runtimeReply({
				status: 200,
				body: { document: { notebook_id: 'local', etag: 'saved', saved_etag: 'saved' }, cells: {} },
			}),
		);
		const response = await request('POST', `/notebooks/${id}/save`, {}, 'save', {
			'If-Match': 'saved',
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			document: { notebook_id: id, saved_etag: 'saved' },
		});
		expect(await deps.services.notebooks.getNotebookContent(project.id, notebook.id)).toBe(
			'saved source',
		);
		expect(vi.mocked(requestRuntimeHost).mock.calls[0][1].headers).toMatchObject({
			'If-Match': 'saved',
		});
	});

	it('preserves upstream conflicts and rewrites their notebook references', async () => {
		const { request, id, runtime } = await setup();
		await runtime();
		vi.mocked(requestRuntimeHost).mockResolvedValue(
			runtimeReply({
				status: 409,
				body: {
					type: 'tag:marimo.io,2026:host/conflict',
					title: 'conflict',
					status: 409,
					edit: { change: 0, cell: { notebook_id: 'local' }, document: { notebook_id: 'local' } },
				},
			}),
		);
		const response = await request('POST', `/notebooks/${id}/edits`, { changes: [] }, 'edit');
		expect(response.status).toBe(409);
		expect(response.headers.get('content-type')).toBe('application/problem+json');
		expect(await response.json()).toMatchObject({
			edit: { cell: { notebook_id: id }, document: { notebook_id: id } },
		});
	});

	it('forwards execution and interruption and refreshes a retried run', async () => {
		const { request, id, runtime } = await setup();
		await runtime();
		const bridge = vi.mocked(requestRuntimeHost);
		const reply = (status: string): HostReply =>
			runtimeReply({
				status: 202,
				body: { id: 'run-1', notebook_id: 'local', status },
			});
		bridge
			.mockResolvedValueOnce(reply('running'))
			.mockResolvedValueOnce(reply('completed'))
			.mockResolvedValueOnce(reply('running'));
		expect(
			await (
				await request(
					'POST',
					`/notebooks/${id}/runtime/runs`,
					{ cells: [{ id: 'c1', code_hash: 'hash' }] },
					'run',
				)
			).json(),
		).toMatchObject({ id: 'run-1', notebook_id: id, status: 'running' });
		expect(
			await (
				await request(
					'POST',
					`/notebooks/${id}/runtime/runs`,
					{ cells: [{ id: 'c1', code_hash: 'hash' }] },
					'run',
				)
			).json(),
		).toMatchObject({ id: 'run-1', status: 'completed' });
		expect(
			(await request('DELETE', `/notebooks/${id}/runtime/runs/run-1`, undefined, 'interrupt'))
				.status,
		).toBe(202);
		expect(bridge.mock.calls.at(-1)?.[1]).toMatchObject({
			method: 'DELETE',
			path: '/runtime/runs/run-1',
		});
	});

	it.each(['retired', 'deleted'] as const)(
		'keeps a run pinned after a lost reply when its session is %s',
		async (state) => {
			const { request, deps, id, runtime, project } = await setup();
			const original = await runtime();
			const bridge = vi.mocked(requestRuntimeHost);
			bridge.mockRejectedValueOnce(new UnavailableError('Reply lost after acceptance'));
			const run = () =>
				request('POST', `/notebooks/${id}/runtime/runs`, { code: 'side_effect()' }, 'lost-run');
			expect((await run()).status).toBe(503);
			await deps.services.sessions.terminate(project.id, original.session_id);
			await deps.services.sessions.markSandboxReclaimed(
				project.id,
				original.session_id,
				new Date().toISOString(),
			);
			await deps.services.sessions.releaseEditorFor(original);
			const replacement = await runtime();
			expect(replacement.session_id).not.toBe(original.session_id);
			if (state === 'deleted') {
				const getSession = deps.services.sessions.getSession.bind(deps.services.sessions);
				vi.spyOn(deps.services.sessions, 'getSession').mockImplementation(async (pid, sid) => {
					if (sid === original.session_id) throw new NotFoundError('Session removed');
					return getSession(pid, sid);
				});
			}
			bridge.mockResolvedValue(
				runtimeReply({ status: 202, body: { id: 'second-run', notebook_id: 'local' } }),
			);
			const create = vi.spyOn(deps.services.sessions, 'createSession');
			for (let index = 0; index < 2; index++) {
				const response = await run();
				expect(response.status).toBe(409);
				expect(await response.json()).toMatchObject({ type: 'tag:marimo.io,2026:host/no-runtime' });
			}
			expect(bridge).toHaveBeenCalledOnce();
			expect(create).not.toHaveBeenCalled();
		},
	);

	it('retries a lost run reply against the original runtime and upstream key', async () => {
		const { request, deps, id, runtime } = await setup();
		const session = await runtime();
		const create = vi.spyOn(deps.services.sessions, 'createSession');
		const connect = vi.spyOn(deps.compute, 'create');
		const bridge = vi.mocked(requestRuntimeHost);
		bridge.mockRejectedValueOnce(new UnavailableError('Reply lost')).mockResolvedValueOnce(
			runtimeReply({
				status: 202,
				body: { id: 'accepted-run', notebook_id: 'local', status: 'completed' },
			}),
		);
		const run = () =>
			request('POST', `/notebooks/${id}/runtime/runs`, { code: 'side_effect()' }, 'lost-run');
		expect((await run()).status).toBe(503);
		const response = await run();
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ id: 'accepted-run', status: 'completed' });
		expect(bridge.mock.calls[0][1]).toEqual(bridge.mock.calls[1][1]);
		expect(connect.mock.calls.every(([sandboxId]) => sandboxId === session.sandbox_id)).toBe(true);
		expect(create).not.toHaveBeenCalled();
	});

	it('does not replay a run in a replacement sandbox', async () => {
		const { request, deps, id, runtime, project } = await setup();
		const session = await runtime();
		vi.mocked(requestRuntimeHost).mockResolvedValue(
			runtimeReply({
				status: 202,
				body: { id: 'run-1', notebook_id: 'local', status: 'running' },
			}),
		);
		expect(
			(await request('POST', `/notebooks/${id}/runtime/runs`, { code: 'side_effect()' }, 'run'))
				.status,
		).toBe(202);
		await deps.services.sessions.terminate(project.id, session.session_id);
		expect(
			(await request('POST', `/notebooks/${id}/runtime/runs`, { code: 'side_effect()' }, 'run'))
				.status,
		).toBe(409);
		expect(vi.mocked(requestRuntimeHost)).toHaveBeenCalledTimes(1);
	});

	it('rejects unsupported methods without opening a notebook stream', async () => {
		const { request, id, deps } = await setup();
		const create = vi.spyOn(deps.compute, 'create');
		expect((await request('HEAD', `/notebooks/${id}/events`)).status).toBe(405);
		expect((await request('POST', '/events', {})).status).toBe(405);
		expect(create).not.toHaveBeenCalled();
	});

	it.each(['bearer', 'runtime permission'])(
		'closes a notebook stream after %s access is revoked',
		async (revocation) => {
			const { request, id, project, runtime, setUser } = await setup();
			await runtime();
			vi.mocked(requestRuntimeHost)
				.mockResolvedValueOnce(
					runtimeReply({
						status: 200,
						events: [{ event: 'ready', id: 'cursor', data: {} }],
					}),
				)
				.mockRejectedValue(new UnavailableError('Unexpected polling after revocation'));
			const response = await request('GET', `/notebooks/${id}/events`);
			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let text = '';
			while (!text.includes('event: ready')) {
				const chunk = await reader.read();
				text += decoder.decode(chunk.value);
			}
			setUser(
				revocation === 'bearer'
					? null
					: {
							...user,
							credential: {
								...user.credential,
								grant: { actions: ['project.read', 'session.attach'], projects: [project.id] },
							},
						},
			);
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				text += decoder.decode(chunk.value);
			}
			await reader.cancel();
			expect(text).toContain('event: effect/httpapi/stream/failure');
			expect(text).toContain(
				`tag:marimo.io,2026:host/${revocation === 'bearer' ? 'unauthorized' : 'forbidden'}`,
			);
			expect(vi.mocked(requestRuntimeHost)).toHaveBeenCalledTimes(1);
		},
	);

	it('uses the latest name and permissions in every reset snapshot', async () => {
		const { request, deps, id, project, notebook, runtime, setUser } = await setup();
		await runtime();
		const ready: HostEvent = { event: 'ready', data: {} };
		vi.mocked(requestRuntimeHost)
			.mockResolvedValueOnce(runtimeReply({ status: 200, events: [ready] }))
			.mockResolvedValue(
				runtimeReply({ status: 200, events: [{ event: 'reset', data: {} }, ready] }),
			);
		const response = await request('GET', `/notebooks/${id}/events`);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let text = '';
		const readThroughReady = async (count: number) => {
			while (text.split('event: ready\n').length <= count) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error('Stream ended before ready');
				text += decoder.decode(chunk.value);
			}
		};
		try {
			await readThroughReady(1);
			await deps.services.notebooks.updateNotebook(
				project.id,
				notebook.id,
				{ title: 'Renamed' },
				user.id,
			);
			setUser({
				...user,
				credential: {
					...user.credential,
					grant: {
						actions: ['project.read', 'session.start', 'session.attach'],
						projects: [project.id],
					},
				},
			});
			await readThroughReady(3);
			const resets = text.split('event: reset\n').slice(1);
			expect(resets).toHaveLength(2);
			for (const reset of resets) {
				const frame = reset.split('\n\n').find((block) => block.includes('event: notebook\n'))!;
				const { notebook: record } = JSON.parse(/^data: (.+)$/m.exec(frame)![1]) as {
					notebook: { name: string; operations: string[] };
				};
				expect(record.name).toBe('Renamed');
				expect(record.operations).toContain('runtime.run');
				expect(record.operations).not.toContain('notebook.edit');
				expect(record.operations).not.toContain('notebook.save');
				expect(record.operations).not.toContain('notebook.update');
			}
		} finally {
			await reader.cancel();
		}
	});

	it('emits each attachment once when another client joins during a stalled snapshot', async () => {
		const { request, id, runtime } = await setup();
		await runtime();
		vi.mocked(requestRuntimeHost).mockResolvedValue(
			runtimeReply({
				status: 200,
				events: [
					{ event: 'document', data: { document: { notebook_id: 'local', order: [] } } },
					{ event: 'ready', id: 'cursor', data: {} },
				],
			}),
		);
		const first = await request('GET', `/notebooks/${id}/events`);
		const second = await request('GET', `/notebooks/${id}/events`);
		const reader = first.body!.getReader();
		const decoder = new TextDecoder();
		let text = '';
		try {
			while (text.split('event: document\n').length < 3) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error('Stream ended before the next runtime batch');
				text += decoder.decode(chunk.value);
			}
			const joined = text
				.split('\n\n')
				.filter((frame) => frame.includes('event: attachment\n'))
				.map((frame) => {
					const data = JSON.parse(/^data: (.+)$/m.exec(frame)![1]) as {
						attachment: { id: string };
					};
					return data.attachment.id;
				});
			expect(joined).toHaveLength(2);
			expect(new Set(joined).size).toBe(2);
		} finally {
			await reader.cancel();
			await second.body!.cancel();
		}
	});

	it('maps document streams and keeps attachment identity separate from its connection id', async () => {
		const { request, id, runtime } = await setup();
		const session = await runtime();
		vi.mocked(requestRuntimeHost).mockResolvedValue(
			runtimeReply({
				status: 200,
				events: [
					{ event: 'notebook', data: { notebook: { id: 'local' } } },
					{ event: 'attachment', data: { attachment: { id: 'internal' } } },
					{ event: 'cell', data: { cell: { id: 'c1', notebook_id: 'local', code: 'x = 1' } } },
					{ event: 'document', data: { document: { notebook_id: 'local', order: ['c1'] } } },
					{ event: 'runtime', data: { runtime: { id: 'kernel', notebook_id: 'local' } } },
					{ event: 'ready', id: 'cursor', data: {} },
				],
			}),
		);
		const events = await readSnapshot(
			await request('GET', `/notebooks/${id}/events`, undefined, undefined, {
				'Marimo-Attachment-Identity': 'client-1',
				'Marimo-Attachment-Kind': 'agent',
			}),
		);
		expect(events.map((e) => e.event)).toEqual([
			'notebook',
			'attachment',
			'cell',
			'document',
			'runtime',
			'ready',
		]);
		expect(events[1]).toMatchObject({
			data: { attachment: { identity: 'client-1', kind: 'agent', notebook_id: id } },
		});
		expect((events[1].data.attachment as { id: string }).id).not.toBe('client-1');
		expect(events[2]).toMatchObject({ data: { cell: { notebook_id: id } } });
		expect(events[4]).toMatchObject({
			data: { runtime: { id: `${session.session_id}:kernel`, notebook_id: id } },
		});
		const catalog = await readSnapshot(await request('GET', '/events?types=attachment'));
		expect(catalog.map((event) => event.event)).toEqual(['ready']);
	});
});

const otherUser: AuthenticatedPrincipal = {
	...user,
	id: UserId.parse('host-other'),
	email: 'other@example.com',
};

async function ownedEditor() {
	const fixture = await setup({ editorSandboxSharing: 'exclusive', defaultRole: 'editor' });
	const holder = await fixture.runtime();
	await fixture.deps.services.projects.addMember(
		fixture.project.id,
		{ user_id: otherUser.id },
		'editor',
		user.id,
	);
	fixture.setUser(otherUser);
	const path = `/notebooks/${fixture.id}/runtime`;
	const response = await fixture.request('PUT', path, {}, 'initial-start');
	expect(response.status).toBe(409);
	const problem = (await response.json()) as { type: string; decisions: HostDecision[] };
	expect(problem.type).toBe('tag:marimo.io,2026:host/decision-required');
	const decision = problem.decisions[0];
	const choose = (choice: string, key = choice) =>
		fixture.request('PUT', path, { decisions: { [decision.id]: choice } }, key);
	return { ...fixture, holder, decision, choose };
}

function mockStartedRuntime() {
	vi.mocked(requestRuntimeHost).mockResolvedValue(
		runtimeReply({
			status: 200,
			body: { id: 'kernel', notebook_id: 'local', state: 'idle' },
		}),
	);
}

describe('host editor ownership', () => {
	it('reuses a shared editor across users, including after the default policy changes', async () => {
		const fixture = await setup({ editorSandboxSharing: 'shared', defaultRole: 'editor' });
		const holder = await fixture.runtime();
		fixture.deps.policy.editorSandboxSharing = 'exclusive';
		fixture.setUser(otherUser);
		mockStartedRuntime();
		const create = vi.spyOn(fixture.deps.services.sessions, 'createSession');
		const response = await fixture.request('PUT', `/notebooks/${fixture.id}/runtime`, {}, 'shared');
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id: `${holder.session_id}:kernel`,
			notebook_id: fixture.id,
		});
		expect(create).not.toHaveBeenCalled();
	});

	it('offers explicit choices and cancels without creating or retiring a sandbox', async () => {
		const fixture = await ownedEditor();
		expect(fixture.decision.options.map((option: { id: string }) => option.id)).toEqual([
			'cancel',
			'takeover',
			'temporary',
		]);
		const create = vi.spyOn(fixture.deps.services.sessions, 'createSession');
		const retire = vi.spyOn(SessionRetirer.prototype, 'retireForTakeover');
		const response = await fixture.choose('cancel');
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ detail: 'Runtime start cancelled' });
		expect(create).not.toHaveBeenCalled();
		expect(retire).not.toHaveBeenCalled();
		expect(requestRuntimeHost).not.toHaveBeenCalled();
		expect(
			(await fixture.deps.services.sessions.getEditorClaim(fixture.project.id, fixture.notebook.id))
				?.session_id,
		).toBe(fixture.holder.session_id);
	});

	it.each([
		['POST', '/edits', { edits: [] }],
		['POST', '/runtime/runs', { code: '1 + 1' }],
		['POST', '/save', {}],
		['GET', '/events', undefined],
	] as const)(
		'does not let a second user bypass the decision through %s %s',
		async (method, suffix, body) => {
			const fixture = await ownedEditor();
			const response = await fixture.request(
				method,
				`/notebooks/${fixture.id}${suffix}`,
				body,
				'bypass',
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				type: 'tag:marimo.io,2026:host/decision-required',
			});
			expect(requestRuntimeHost).not.toHaveBeenCalled();
		},
	);

	it('takes over through the shared retirement path and fences the displaced editor', async () => {
		const fixture = await ownedEditor();
		mockStartedRuntime();
		const retire = vi.spyOn(SessionRetirer.prototype, 'retireForTakeover');
		const response = await fixture.choose('takeover');
		expect(response.status).toBe(200);
		const result = (await response.json()) as { id: string; notebook_id: string };
		expect(result.notebook_id).toBe(fixture.id);
		expect(result.id).not.toBe(`${fixture.holder.session_id}:kernel`);
		expect(retire).toHaveBeenCalledOnce();
		const old = await fixture.deps.services.sessions.getSession(
			fixture.project.id,
			fixture.holder.session_id,
		);
		expect(old).toMatchObject({
			status: 'terminated',
			ended_reason: 'takeover',
			ended_by_user_id: otherUser.id,
		});
		expect((await fixture.choose('takeover')).status).toBe(200);
		expect(retire).toHaveBeenCalledOnce();
		fixture.setUser(user);
		const displaced = await fixture.request(
			'POST',
			`/notebooks/${fixture.id}/edits`,
			{},
			'displaced',
		);
		expect(displaced.status).toBe(409);
		expect(await displaced.json()).toMatchObject({
			type: 'tag:marimo.io,2026:host/decision-required',
		});
	});

	it('starts an owner-only temporary notebook with no save or rename capability', async () => {
		const fixture = await ownedEditor();
		mockStartedRuntime();
		const response = await fixture.choose('temporary');
		expect(response.status).toBe(200);
		const result = (await response.json()) as { id: string; notebook_id: string };
		const parsed = HostNotebookId.parse(result.notebook_id);
		expect(parsed).toMatchObject({
			projectId: fixture.project.id,
			notebookId: fixture.notebook.id,
		});
		expect(parsed.sessionId).toBeDefined();
		const session = await fixture.deps.services.sessions.getSession(
			fixture.project.id,
			parsed.sessionId!,
		);
		expect(session).toMatchObject({
			ephemeral: true,
			user_id: otherUser.id,
			editor_sandbox_sharing: 'exclusive',
		});
		expect(
			(await fixture.deps.services.sessions.getEditorClaim(fixture.project.id, fixture.notebook.id))
				?.session_id,
		).toBe(fixture.holder.session_id);
		const events = await readSnapshot(await fixture.request('GET', '/events?types=notebook'));
		const notebook = events.find(
			(event) => (event.data.notebook as { id?: string })?.id === result.notebook_id,
		)?.data.notebook as { operations: string[] };
		expect(notebook.operations).toEqual(
			expect.arrayContaining(['notebook.edit', 'runtime.run', 'runtime.interrupt']),
		);
		expect(notebook.operations).not.toContain('notebook.save');
		expect(notebook.operations).not.toContain('notebook.update');
		const path = `/notebooks/${result.notebook_id}`;
		vi.mocked(requestRuntimeHost).mockClear();
		expect((await fixture.request('POST', `${path}/save`, {}, 'save-temp')).status).toBe(403);
		expect(
			(await fixture.request('PATCH', path, { name: 'Cannot rename' }, 'rename-temp')).status,
		).toBe(403);
		expect(requestRuntimeHost).not.toHaveBeenCalled();
		for (const suffix of ['/edits', '/runtime/runs'])
			expect((await fixture.request('POST', `${path}${suffix}`, {}, suffix)).status).toBe(200);
		fixture.setUser(user);
		vi.mocked(requestRuntimeHost).mockClear();
		expect((await fixture.request('POST', `${path}/edits`, {}, 'wrong-user')).status).toBe(404);
		const hidden = await readSnapshot(await fixture.request('GET', '/events?types=notebook'));
		expect(
			hidden.some((event) => (event.data.notebook as { id?: string })?.id === result.notebook_id),
		).toBe(false);
		expect(requestRuntimeHost).not.toHaveBeenCalled();
	});

	it('re-prompts for a stale holder instead of taking over its replacement', async () => {
		const fixture = await ownedEditor();
		await fixture.deps.services.sessions.releaseEditorFor(fixture.holder);
		const replacement = await fixture.runtime();
		const response = await fixture.choose('takeover');
		expect(response.status).toBe(409);
		const problem = (await response.json()) as { type: string; decisions: HostDecision[] };
		expect(problem.type).toBe('tag:marimo.io,2026:host/decision-required');
		expect(problem.decisions[0].id).toContain(replacement.session_id);
		expect(requestRuntimeHost).not.toHaveBeenCalled();
	});

	it('re-prompts when activity changed and leaves the holder running', async () => {
		const fixture = await ownedEditor();
		const stale = fixture.decision.id.replace(/:[^:]+$/, ':active');
		const response = await fixture.request(
			'PUT',
			`/notebooks/${fixture.id}/runtime`,
			{ decisions: { [stale]: 'takeover' } },
			'stale-activity',
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			type: 'tag:marimo.io,2026:host/decision-required',
		});
		expect(
			(
				await fixture.deps.services.sessions.getSession(
					fixture.project.id,
					fixture.holder.session_id,
				)
			).status,
		).toBe('running');
		expect(
			(await fixture.deps.services.sessions.getEditorClaim(fixture.project.id, fixture.notebook.id))
				?.transfer,
		).toBeUndefined();
		expect(requestRuntimeHost).not.toHaveBeenCalled();
	});

	it('rejects malformed and conflicting decisions without starting compute', async () => {
		const fixture = await ownedEditor();
		const create = vi.spyOn(fixture.deps.compute, 'create');
		for (const decisions of [
			{ [fixture.decision.id]: 'invalid' },
			{ 'hub-editor:bad:idle': 'takeover' },
			{ [`${fixture.decision.id}:extra`]: 'takeover' },
			{ [fixture.decision.id]: 'takeover', [`hub-editor:${SessionId.create()}:idle`]: 'temporary' },
		]) {
			const response = await fixture.request(
				'PUT',
				`/notebooks/${fixture.id}/runtime`,
				{ decisions },
				crypto.randomUUID(),
			);
			expect(response.status).toBe(400);
		}
		expect(create).not.toHaveBeenCalled();
	});

	it('does not start a replacement when takeover retirement fails', async () => {
		const fixture = await ownedEditor();
		vi.spyOn(SessionRetirer.prototype, 'retireForTakeover').mockRejectedValue(
			new Error('Cannot save'),
		);
		const create = vi.spyOn(fixture.deps.services.sessions, 'createSession');
		expect((await fixture.choose('takeover')).status).toBe(503);
		expect(create).not.toHaveBeenCalled();
		expect(requestRuntimeHost).not.toHaveBeenCalled();
	});
	it('requires fresh authorization for a decision and cannot escalate a restricted token', async () => {
		const fixture = await ownedEditor();
		fixture.setUser({
			...otherUser,
			credential: {
				...otherUser.credential,
				grant: {
					actions: ['project.read', 'session.start', 'session.attach'],
					projects: [fixture.project.id],
				},
			},
		});
		const retire = vi.spyOn(SessionRetirer.prototype, 'retireForTakeover');
		for (const choice of ['takeover', 'temporary'])
			expect((await fixture.choose(choice)).status).toBe(403);
		expect(retire).not.toHaveBeenCalled();
		expect(requestRuntimeHost).not.toHaveBeenCalled();
	});

	it('retries a failed runtime connection after takeover without retiring the new owner', async () => {
		const fixture = await ownedEditor();
		mockStartedRuntime();
		vi.mocked(requestRuntimeHost).mockRejectedValueOnce(new UnavailableError('Not ready'));
		const retire = vi.spyOn(SessionRetirer.prototype, 'retireForTakeover');
		expect((await fixture.choose('takeover')).status).toBe(503);
		const claim = await fixture.deps.services.sessions.getEditorClaim(
			fixture.project.id,
			fixture.notebook.id,
		);
		expect((await fixture.choose('takeover')).status).toBe(200);
		expect(retire).toHaveBeenCalledOnce();
		expect(
			(await fixture.deps.services.sessions.getEditorClaim(fixture.project.id, fixture.notebook.id))
				?.session_id,
		).toBe(claim?.session_id);
	});

	it('rejects stale and forged temporary notebook IDs without provisioning a replacement', async () => {
		const fixture = await ownedEditor();
		mockStartedRuntime();
		const result = (await (await fixture.choose('temporary')).json()) as { notebook_id: string };
		const parsed = HostNotebookId.parse(result.notebook_id);
		await fixture.deps.services.sessions.markTerminated(fixture.project.id, parsed.sessionId!);
		fixture.setUser(user);
		const create = vi.spyOn(fixture.deps.services.sessions, 'createSession');
		vi.mocked(requestRuntimeHost).mockClear();
		for (const id of [
			result.notebook_id,
			HostNotebookId.create(fixture.project.id, fixture.notebook.id, fixture.holder.session_id),
			HostNotebookId.create(fixture.project.id, fixture.notebook.id, SessionId.create()),
		]) {
			expect(
				(await fixture.request('PUT', `/notebooks/${id}/runtime`, {}, crypto.randomUUID())).status,
			).toBe(404);
		}
		fixture.setUser(otherUser);
		expect(
			(await fixture.request('PUT', `/notebooks/${result.notebook_id}/runtime`, {}, 'expired-temp'))
				.status,
		).toBe(404);
		expect(create).not.toHaveBeenCalled();
		expect(requestRuntimeHost).not.toHaveBeenCalled();
	});

	it('keeps the claim policy and does not publish another owner’s cached runtime', async () => {
		const fixture = await ownedEditor();
		fixture.setUser(user);
		mockStartedRuntime();
		expect(
			(await fixture.request('PUT', `/notebooks/${fixture.id}/runtime`, {}, 'owner-start')).status,
		).toBe(200);
		fixture.deps.policy.editorSandboxSharing = 'shared';
		fixture.setUser(otherUser);
		const events = await readSnapshot(await fixture.request('GET', '/events'));
		expect(events.filter((event) => event.event === 'runtime')).toEqual([]);
		const response = await fixture.request(
			'PUT',
			`/notebooks/${fixture.id}/runtime`,
			{},
			'changed-default',
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			type: 'tag:marimo.io,2026:host/decision-required',
		});
	});

	it('forwards runtime decisions without leaking the hub ownership choice', async () => {
		const fixture = await ownedEditor();
		mockStartedRuntime();
		const response = await fixture.request(
			'PUT',
			`/notebooks/${fixture.id}/runtime`,
			{
				decisions: { [fixture.decision.id]: 'temporary', environment: 'python' },
			},
			'combined-decisions',
		);
		expect(response.status).toBe(200);
		expect(vi.mocked(requestRuntimeHost).mock.calls[0][1].body).toEqual({
			decisions: { environment: 'python' },
		});
	});
	it('does not start another editor while a takeover is in progress', async () => {
		const fixture = await ownedEditor();
		await fixture.deps.services.sessions.reserveTakeover(fixture.project.id, fixture.notebook.id, {
			takeoverId: 'other-request',
			requestedBy: otherUser.id,
			expectedHolder: fixture.holder.session_id,
			expectedActivity: 'unknown',
		});
		const create = vi.spyOn(fixture.deps.services.sessions, 'createSession');
		for (const response of [
			await fixture.request('PUT', `/notebooks/${fixture.id}/runtime`, {}, 'during-takeover'),
			await fixture.choose('takeover'),
			await fixture.choose('temporary'),
		])
			expect(response.status).toBe(409);
		expect(create).not.toHaveBeenCalled();
		expect(requestRuntimeHost).not.toHaveBeenCalled();
	});
});
