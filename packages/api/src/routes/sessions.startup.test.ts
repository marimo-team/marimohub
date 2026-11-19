import { afterEach, expect, it, vi } from 'vitest';
import { createServices, UnavailableError } from '@marimo-hub/core';
import { backgroundWorkFrom } from '@marimo-hub/core/ports/background-work';
import type { BackgroundWork } from '@marimo-hub/core/ports/background-work';
import type { SessionId } from '@marimo-hub/core';
import {
	ACTOR,
	fakeComputeFrom,
	makeFakeSandbox,
	RecordingBucket,
	uid,
} from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectOk, expectError } from '../testing';
import type { SessionCreateResult } from './sessionStart';

async function fixture(
	role?: 'app-user' | 'viewer' | 'editor' | 'manager',
	backgroundWork?: BackgroundWork,
) {
	const inner = await createInitializedBucket();
	const bucket = new RecordingBucket(inner);
	const { instance, calls } = makeFakeSandbox();
	const compute = fakeComputeFrom(instance);
	const api = createTestApi({
		bucket: inner,
		compute,
		userId: role ? uid('startup-reader') : ACTOR,
		deps: {
			backgroundWork,
			bucket,
			services: createServices(bucket),
			...(role ? { policy: { defaultRole: role, viewerMode: 'applications' as const } } : {}),
		},
	});
	const project = await api.deps.services.projects.createProject(
		{ name: 'Startup', description: '' },
		ACTOR,
	);
	const notebook = await api.deps.services.notebooks.createNotebook(
		project.id,
		{ title: 'Notebook', description: '', code: 'import marimo as mo' },
		ACTOR,
	);
	const path = `/projects/${project.id}/notebooks/${notebook.id}/sessions`;
	return { ...api, bucket, inner, compute, instance, calls, path, project, notebook };
}
const headers = { Accept: 'text/event-stream' };
function resultFrom(body: string): SessionCreateResult {
	const data = body
		.split('\n\n')
		.find((event) => event.startsWith('event: result\n'))!
		.split('\ndata: ')[1];
	return (JSON.parse(data) as { data: SessionCreateResult }).data;
}
afterEach(() => vi.restoreAllMocks());

it.each(['edit', 'app'] as const)(
	'streams a queued %s start before completion and preserves the final result',
	async (mode) => {
		const env = await fixture();
		const ready = Promise.withResolvers<void>();
		env.instance.ready = () => ready.promise;
		const create = env.compute.create.bind(env.compute);
		vi.spyOn(env.compute, 'create').mockImplementation((id, options) => {
			options?.onProgress?.({ phase: 'allocating', detail: 'Waiting in queue' });
			return create(id, options);
		});
		const response = await env.request('POST', env.path, { mode }, headers);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(response.headers.get('x-accel-buffering')).toBe('no');
		expect(response.headers.has('etag')).toBe(false);
		const reader = response.body!.getReader();
		let body = '';
		try {
			while (!body.includes(mode === 'edit' ? 'event: progress' : ': connected'))
				body += new TextDecoder().decode((await reader.read()).value);
			expect(body).not.toContain('event: result');
		} finally {
			ready.resolve();
		}
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			body += new TextDecoder().decode(next.value);
		}
		const result = resultFrom(body);
		if (mode === 'app') {
			expect(body).not.toContain('event: progress');
			expect(body).not.toContain('Waiting in queue');
		}
		expect(result.status).toBe('running');
		if (mode === 'app') expect(result.app_assignment).toBeDefined();
		expect(result).not.toHaveProperty('startup');
		const stored = await env.deps.services.sessions.getSession(
			env.project.id,
			result.session_id as SessionId,
		);
		expect(stored.startup).toMatchObject({
			phase: 'starting',
			sandbox_id: stored.sandbox_id,
		});
		expect(stored).not.toHaveProperty('startup_request_id');
	},
);

it.each(['app-user', 'viewer', 'editor', 'manager'] as const)(
	'withholds app startup progress from %s users',
	async (role) => {
		const env = await fixture(role);
		const create = env.compute.create.bind(env.compute);
		const spy = vi.spyOn(env.compute, 'create').mockImplementation((id, options) => {
			options?.onProgress?.({ phase: 'allocating', detail: 'Private infrastructure detail' });
			return create(id, options);
		});
		const response = await env.request('POST', env.path, { mode: 'app' }, headers);
		const body = await response.text();
		expect(resultFrom(body).status).toBe('running');
		expect(spy).toHaveBeenCalled();
		expect(spy.mock.calls[0][1]?.onProgress).toBeTypeOf('function');
		expect(body).not.toContain('event: progress');
		expect(body).not.toContain('Private infrastructure detail');
	},
);

it.each(['edit', 'app'] as const)(
	'uses exactly the JSON %s start bucket-operation counts',
	async (mode) => {
		const counts = [];
		for (const streaming of [false, true]) {
			const env = await fixture();
			for (const calls of Object.values(env.bucket.calls)) calls.length = 0;
			const response = await env.request(
				'POST',
				env.path,
				{ mode },
				streaming ? headers : undefined,
			);
			const result = streaming
				? resultFrom(await response.text())
				: await expectOk<SessionCreateResult>(response);
			expect(result.status).toBe('running');
			counts.push(
				Object.fromEntries(
					Object.entries(env.bucket.calls).map(([key, calls]) => [key, calls.length]),
				),
			);
		}
		expect(counts[1]).toEqual(counts[0]);
	},
);

it('returns a normal authorization error before opening a stream', async () => {
	const env = await fixture();
	await env.deps.services.projects.deleteProject(env.project.id, ACTOR);
	await expectError(await env.request('POST', env.path, undefined, headers), 404);
});

it('returns reused sessions immediately without inventing progress', async () => {
	const env = await fixture();
	const first = await expectOk<SessionCreateResult>(await env.request('POST', env.path));
	const response = await env.request('POST', env.path, undefined, headers);
	const body = await response.text();
	expect(body).not.toContain('event: progress');
	expect(resultFrom(body)).toMatchObject({ reused: true, session_id: first.session_id });
});

it('continues provisioning after the response reader disconnects', async () => {
	const env = await fixture();
	const ready = Promise.withResolvers<void>();
	env.instance.ready = () => ready.promise;
	const running = vi.spyOn(env.deps.services.sessions, 'setRunning');
	const response = await env.request('POST', env.path, undefined, headers);
	await response.body!.cancel();
	ready.resolve();
	await vi.waitFor(() => expect(running).toHaveBeenCalled());
});

it.each(['edit', 'app'] as const)(
	'cleans up a failed %s start and sends a safe terminal error',
	async (mode) => {
		const env = await fixture();
		env.instance.ready = async () => {
			throw new Error('Secret provider credentials');
		};
		const response = await env.request('POST', env.path, { mode }, headers);
		const body = await response.text();
		expect(response.status).toBe(200);
		expect(body).toContain('event: error');
		expect(body).toContain('SERVICE_UNAVAILABLE');
		expect(body).not.toContain('Secret provider credentials');
		expect(body).not.toContain('event: result');
		expect(env.calls.destroy).toBe(1);
		const stored = await env.deps.services.sessions.listSessions();
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ status: 'failed', error: { code: 'SERVICE_UNAVAILABLE' } });
		expect(
			(await env.deps.services.sessions.getEditorClaim(env.project.id, env.notebook.id))
				?.session_id ?? null,
		).toBeNull();
	},
);

it('denies an unauthorized caller before sending progress or allocating compute', async () => {
	const env = await fixture();
	const create = vi.spyOn(env.compute, 'create');
	const stranger = createTestApi({
		bucket: env.inner,
		compute: env.compute,
		userId: uid('stranger'),
	});
	const response = await stranger.request('POST', env.path, undefined, headers);
	expect(response.headers.get('content-type')).toContain('application/json');
	await expectError(response, 403, 'FORBIDDEN');
	expect(create).not.toHaveBeenCalled();
	expect(await env.deps.services.sessions.listSessions()).toHaveLength(0);
});

it('compensates and sends a terminal error when authorization expires during startup', async () => {
	const env = await fixture();
	const now = Date.now();
	const deadline = now + 60_000;
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	const expose = env.instance.exposePort.bind(env.instance);
	env.instance.exposePort = async (...args) => {
		const result = await expose(...args);
		clock.mockReturnValue(deadline);
		return result;
	};
	const editor = createTestApi({
		bucket: env.inner,
		compute: env.compute,
		deps: {
			authenticator: {
				authenticate: async () => ({
					credential: { kind: 'development' },
					id: uid('group-editor'),
					email: 'editor@example.com',
					entitlements: ['default-role:editor'],
					entitlementsExpiresAt: new Date(deadline).toISOString(),
				}),
			},
		},
	});
	const response = await editor.request('POST', env.path, undefined, headers);
	expect(response.status).toBe(200);
	const body = await response.text();
	expect(body).toContain('event: error');
	expect(body).toContain('FORBIDDEN');
	expect(body).not.toContain('event: result');
	expect(env.calls.destroy).toBe(1);
	expect(await env.deps.services.sessions.listSessions()).toEqual([
		expect.objectContaining({
			status: 'failed',
			error: expect.objectContaining({ code: 'FORBIDDEN' }),
		}),
	]);
});

it('preserves the final deletion check after the stream opens', async () => {
	const env = await fixture();
	const ready = Promise.withResolvers<void>();
	env.instance.ready = () => ready.promise;
	const response = await env.request('POST', env.path, undefined, headers);
	try {
		await env.deps.services.projects.deleteProject(env.project.id, ACTOR);
	} finally {
		ready.resolve();
	}
	const body = await response.text();
	expect(body).toContain('event: error');
	expect(body).toContain('NOT_FOUND');
	expect(body).not.toContain('event: result');
});

it.each(['before', 'after'] as const)(
	'compensates for failure %s the running write',
	async (timing) => {
		const env = await fixture();
		const sessions = env.deps.services.sessions;
		const write = sessions.setRunning.bind(sessions);
		const error = new Error('Private storage failure');
		let committedStatus: string | undefined;
		vi.spyOn(sessions, 'setRunning').mockImplementation(async (...args) => {
			if (timing === 'after') committedStatus = (await write(...args)).status;
			throw error;
		});
		const response = await env.request('POST', env.path, undefined, headers);
		const body = await response.text();
		expect(body).toContain('event: error');
		expect(body).not.toContain('event: result');
		expect(body).not.toContain(error.message);
		expect(committedStatus).toBe(timing === 'after' ? 'running' : undefined);
		expect(env.calls.destroy).toBeGreaterThan(0);
		expect(await sessions.listByProject(env.project.id)).toEqual([
			expect.objectContaining({
				status: 'failed',
				error: { code: 'PROVISION_FAILED', message: expect.any(String) },
				sandbox_reclaimed_at: expect.any(String),
				startup: expect.objectContaining({ phase: 'starting' }),
			}),
		]);
	},
);

it.each(['before', 'after', 'stalled'] as const)(
	'does not block or fail a healthy launch for progress storage failure: %s',
	async (failure) => {
		const work: Promise<unknown>[] = [];
		const env = await fixture(
			undefined,
			backgroundWorkFrom((task) => work.push(task)),
		);
		const ready = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const stalled = Promise.withResolvers<void>();
		env.instance.ready = () => ready.promise;
		const sessions = env.deps.services.sessions;
		const write = sessions.recordStartupProgress.bind(sessions);
		let committedStatus: string | undefined;
		vi.spyOn(sessions, 'recordStartupProgress').mockImplementation(async (...args) => {
			if (failure === 'after') committedStatus = (await write(...args)).status;
			entered.resolve();
			if (failure === 'stalled') {
				await stalled.promise;
				return write(...args);
			}
			throw new Error('Private progress storage failure');
		});
		const response = await env.request('POST', env.path, undefined, headers);
		await entered.promise;
		ready.resolve();
		try {
			const body = await response.text();
			const result = resultFrom(body);
			expect(result.status).toBe('running');
			expect(body).not.toContain('event: error');
			expect(body).not.toContain('Private progress storage failure');
			expect(env.calls.destroy).toBe(0);
			expect(committedStatus).toBe(failure === 'after' ? 'starting' : undefined);
			expect(
				await sessions.getStartupStatus(env.project.id, result.session_id as SessionId),
			).toMatchObject({ status: 'running', startup: { phase: 'starting' }, error: null });
		} finally {
			stalled.resolve();
			await Promise.all(work);
		}
		const stored = await sessions.listByProject(env.project.id);
		expect(stored[0]).toMatchObject({ status: 'running', startup: { phase: 'starting' } });
	},
);

function errorFrom(body: string) {
	const data = body
		.split('\n\n')
		.find((event) => event.startsWith('event: error\n'))!
		.split('\ndata: ')[1];
	return (JSON.parse(data) as { error: Record<string, unknown> }).error;
}

it('logs an unexpected in-stream failure and cites the request id', async () => {
	const env = await fixture();
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(env.compute, 'create').mockImplementation(() => {
		throw new Error('provider secret detail');
	});
	const response = await env.request('POST', env.path, undefined, {
		...headers,
		'X-Request-Id': 'startup-request-1',
	});
	expect(response.status).toBe(200);
	const body = await response.text();
	expect(errorFrom(body)).toEqual({
		code: 'INTERNAL_ERROR',
		message: 'Internal error — ref startup-request-1',
		status: 500,
	});
	expect(body).not.toContain('provider secret detail');
	const logged = log.mock.calls
		.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
		.find((entry) => entry.event === 'request_error');
	expect(logged).toMatchObject({
		request_id: 'startup-request-1',
		status: 500,
		project_id: env.project.id,
		notebook_id: env.notebook.id,
		error: expect.objectContaining({ message: 'provider secret detail' }),
	});
});

it('carries the retry hint for a retriable in-stream failure', async () => {
	const env = await fixture();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(env.compute, 'create').mockImplementation(() => {
		throw new UnavailableError('No sandbox capacity');
	});
	const response = await env.request('POST', env.path, undefined, headers);
	expect(errorFrom(await response.text())).toEqual({
		code: 'SERVICE_UNAVAILABLE',
		message: 'No sandbox capacity',
		status: 503,
		retry_after_ms: 2000,
	});
});
