import { afterEach, expect, it, vi } from 'vitest';
import {
	createProjectId,
	createVersionId,
	createSessionId,
	createSandboxId,
	createNotebookId,
	SessionCaptureCoordinator,
	SessionService,
	paths,
} from '@marimo-hub/core';
import { ACTOR, makeSession, makeFakeCompute, MemoryBucket } from '@marimo-hub/core/testing';
import { queuedBackgroundWork } from '@marimo-hub/core/testing/background-work';
import { observeRuntimeSave } from './sandboxProxy';
import { makeTestDeps } from './testing';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
function fixture() {
	const projectId = createProjectId();
	const sessionId = createSessionId();
	const background = queuedBackgroundWork();
	const metrics = { increment: vi.fn(), gauge: vi.fn() };
	const deps = makeTestDeps(new MemoryBucket(), {
		backgroundWork: background.work,
		metrics,
		compute: makeFakeCompute(),
	});
	const session = makeSession({
		project_id: projectId,
		session_id: sessionId,
		notebook_id: createNotebookId(),
		user_id: ACTOR,
		sandbox_id: createSandboxId(),
		status: 'running',
		save_dirty: { id: crypto.randomUUID(), acknowledged_at: new Date().toISOString() },
	});
	const acknowledge = vi
		.spyOn(deps.services.sessions, 'acknowledgeRuntimeSave')
		.mockResolvedValue(session);
	const capture = vi
		.spyOn(SessionCaptureCoordinator.prototype, 'capture')
		.mockResolvedValue(failedCapture(false));
	const request = new Request('https://hub.test/proxy/token/api/kernel/save', { method: 'POST' });
	const response = new Response('native acknowledgement');
	const decision = {
		kind: 'forward' as const,
		projectId,
		sessionId,
		targetUrl: 'http://runtime/api/kernel/save',
	};
	const getSession = vi.spyOn(deps.services.sessions, 'getSession').mockResolvedValue(session);
	return {
		deps,
		metrics,
		background,
		acknowledge,
		capture,
		request,
		response,
		decision,
		session,
		getSession,
		save: (overrides: Partial<typeof decision> = {}) =>
			observeRuntimeSave(deps, request, response, { ...decision, ...overrides }),
	};
}

const failedCapture = (retryable: boolean, status: 'failed' | 'uncertain' = 'failed') => ({
	critical: {
		status,
		code:
			status === 'uncertain'
				? ('CAPTURE_RECEIPT_FAILED' as const)
				: ('SOURCE_UNAVAILABLE' as const),
		retryable,
		cause: new Error('capture unavailable'),
	},
	workspace: { status: 'skipped' as const },
});

const durable = () => ({
	critical: {
		status: 'durable' as const,
		capturedAt: new Date().toISOString(),
		publication: {
			versionId: createVersionId(),
			newVersion: true,
			capturedHtml: false,
			capturedSession: false,
		},
	},
	workspace: { status: 'skipped' as const },
});

it('persists intent before admission without waiting for artifact capture', async () => {
	const env = fixture();
	await env.save();
	expect(env.acknowledge).toHaveBeenCalledOnce();
	expect(env.capture).not.toHaveBeenCalled();
	expect(env.response.bodyUsed).toBe(false);
	expect(await env.response.text()).toBe('native acknowledgement');
	await env.background.runAll();
	expect(env.capture).toHaveBeenCalledOnce();
});

it.each([
	'/api/marimo/v1/notebooks/nb-test/save',
	'/base/api/marimo/v1/notebooks/folder%2Fnotebook/save?view=edit',
])('observes acknowledged host notebook saves at %s', async (path) => {
	const env = fixture();
	await env.save({ targetUrl: `http://runtime${path}` });
	expect(env.acknowledge).toHaveBeenCalledOnce();
	expect(env.response.bodyUsed).toBe(false);
	await env.background.runAll();
	expect(env.capture).toHaveBeenCalledOnce();
});

it.each([
	'/api/marimo/v1/notebooks//save',
	'/api/marimo/v1/notebooks/nb-test/edits',
	'/api/marimo/v1/notebooks/nb-test/runtime/runs',
	'/api/marimo/v1/notebooks/nb-test/save/extra',
	'/api/marimo/v2/notebooks/nb-test/save',
	'/api/notebooks/nb-test/save',
	'/other?next=/api/marimo/v1/notebooks/nb-test/save',
])('does not treat unrelated host requests as saves: %s', async (path) => {
	const env = fixture();
	await env.save({ targetUrl: `http://runtime${path}` });
	expect(env.acknowledge).not.toHaveBeenCalled();
	expect(env.background.pending()).toBe(0);
});

it.each([
	['GET', 200],
	['PUT', 200],
	['POST', 409],
	['POST', 412],
	['POST', 503],
])('ignores host saves without successful POST acknowledgement (%s %s)', async (method, status) => {
	const env = fixture();
	await observeRuntimeSave(
		env.deps,
		new Request(env.request.url, { method }),
		new Response(null, { status }),
		{
			...env.decision,
			targetUrl: 'http://runtime/api/marimo/v1/notebooks/nb-test/save',
		},
	);
	expect(env.acknowledge).not.toHaveBeenCalled();
	expect(env.background.pending()).toBe(0);
});

it('records every generation while coalescing capture work', async () => {
	const env = fixture();
	await Promise.all(Array.from({ length: 30 }, () => env.save()));
	expect(env.acknowledge).toHaveBeenCalledTimes(30);
	await env.background.runAll();
	expect(env.capture).toHaveBeenCalledOnce();
});

it('persists overflow intent independently of the bounded worker pool', async () => {
	const env = fixture();
	for (let index = 0; index < 100; index++) await env.save({ sessionId: createSessionId() });
	expect(env.acknowledge).toHaveBeenCalledTimes(100);
	expect(env.background.pending()).toBe(64);
	await env.background.runAll();
	expect(env.capture).toHaveBeenCalledTimes(64);
});

it('persists intent without a background host', async () => {
	const env = fixture();
	env.deps.backgroundWork = undefined;
	await env.save();
	expect(env.acknowledge).toHaveBeenCalledOnce();
	expect(env.capture).not.toHaveBeenCalled();
});

it.each(['throw', 'reject'] as const)(
	'retains intent when scheduling fails to %s',
	async (failure) => {
		const env = fixture();
		env.deps.backgroundWork = {
			defer: () => {
				if (failure === 'throw') throw new Error('queue unavailable');
				return Promise.reject(new Error('queue unavailable'));
			},
		};
		await env.save();
		expect(env.acknowledge).toHaveBeenCalledOnce();
		expect(env.metrics.increment).toHaveBeenCalledWith('sessions.save.hint_failed');
		env.deps.backgroundWork = env.background.work;
		await env.save();
		await env.background.runAll();
		expect(env.capture).toHaveBeenCalledOnce();
	},
);

it('reports persistence failures without changing the native response', async () => {
	const env = fixture();
	env.acknowledge.mockRejectedValue(new Error('bucket unavailable'));
	await env.save();
	expect(env.metrics.increment).toHaveBeenCalledWith('sessions.save.hint_failed');
	expect(env.background.pending()).toBe(0);
	expect(await env.response.text()).toBe('native acknowledgement');
});

it.each([
	{ method: 'GET', status: 200 },
	{ method: 'POST', status: 500 },
])('ignores non-save acknowledgements %j', async ({ method, status }) => {
	const env = fixture();
	await observeRuntimeSave(
		env.deps,
		new Request(env.request.url, { method }),
		new Response('', { status }),
		env.decision,
	);
	expect(env.acknowledge).not.toHaveBeenCalled();
});

it('retries failures with bounded exponential backoff', async () => {
	vi.useFakeTimers();
	const env = fixture();
	env.capture.mockResolvedValue(failedCapture(true));
	await env.save();
	const work = env.background.runAll();
	await vi.advanceTimersByTimeAsync(0);
	expect(env.capture).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(100);
	expect(env.capture).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(200);
	expect(env.capture).toHaveBeenCalledTimes(3);
	await vi.advanceTimersByTimeAsync(400);
	await work;
	expect(env.capture).toHaveBeenCalledTimes(4);
	expect(env.acknowledge).toHaveBeenCalledOnce();
	expect(env.session.save_dirty).toBeDefined();
});

it('bounds continuous saves while persisting the final generation', async () => {
	const env = fixture();
	env.capture.mockImplementation(async () => {
		await env.save();
		return durable();
	});
	await env.save();
	await env.background.runAll();
	expect(env.capture).toHaveBeenCalledTimes(4);
	expect(env.acknowledge).toHaveBeenCalledTimes(5);
});

it('rechecks durable dirty state before queued work runs', async () => {
	const env = fixture();
	await env.save();
	env.getSession.mockResolvedValue({ ...env.session, save_dirty: undefined });
	await env.background.runAll();
	expect(env.capture).not.toHaveBeenCalled();
});

it('follows newer dirty state without a local hint', async () => {
	const env = fixture();
	env.capture.mockResolvedValue(durable());
	env.getSession
		.mockResolvedValueOnce(env.session)
		.mockResolvedValueOnce(env.session)
		.mockResolvedValueOnce(env.session)
		.mockResolvedValue({ ...env.session, save_dirty: undefined });
	await env.save();
	await env.background.runAll();
	expect(env.capture).toHaveBeenCalledTimes(2);
});

it('queues follow-ups behind other sessions', async () => {
	const env = fixture();
	const otherId = createSessionId();
	const order: string[] = [];
	env.getSession.mockImplementation(async (_project, id) => ({ ...env.session, session_id: id }));
	env.capture.mockImplementation(async (session) => {
		order.push(session.session_id);
		return durable();
	});
	await env.save();
	await env.save({ sessionId: otherId });
	await env.background.runAll();
	expect(order.slice(0, 4)).toEqual([
		env.decision.sessionId,
		otherId,
		env.decision.sessionId,
		otherId,
	]);
});

it.each(['ephemeral', 'no reconnect'] as const)('skips capture for %s sessions', async (kind) => {
	const env = fixture();
	if (kind === 'ephemeral') env.getSession.mockResolvedValue({ ...env.session, ephemeral: true });
	else env.deps.compute.connectExisting = undefined;
	await env.save();
	await env.background.runAll();
	expect(env.capture).not.toHaveBeenCalled();
});

it('does not admit capture while dirty intent is still being persisted', async () => {
	const env = fixture();
	const persisted = Promise.withResolvers<typeof env.session>();
	env.acknowledge.mockReturnValue(persisted.promise);
	const save = env.save();
	expect(env.background.pending()).toBe(0);
	expect(env.capture).not.toHaveBeenCalled();
	persisted.resolve(env.session);
	await save;
	expect(env.background.pending()).toBe(1);
	await env.background.runAll();
});

it('returns while inline background capture is still blocked', async () => {
	const env = fixture();
	const captured = Promise.withResolvers<ReturnType<typeof durable>>();
	const work: Promise<void>[] = [];
	env.capture.mockReturnValue(captured.promise);
	env.deps.backgroundWork = {
		defer: (_label, task) => {
			const execution = task().then(() => {});
			work.push(execution);
			return execution;
		},
	};
	env.getSession
		.mockResolvedValueOnce(env.session)
		.mockResolvedValue({ ...env.session, save_dirty: undefined });
	await env.save();
	expect(env.capture).toHaveBeenCalledOnce();
	expect(await env.response.text()).toBe('native acknowledgement');
	captured.resolve(durable());
	await Promise.all(work);
});

it.each(['capture', 'read', 'completion read'] as const)(
	'bounds thrown %s failures and releases admission for a later save',
	async (failure) => {
		vi.useFakeTimers();
		const env = fixture();
		const error = new Error('unavailable');
		if (failure === 'capture') env.capture.mockRejectedValue(error);
		if (failure === 'read') env.getSession.mockRejectedValue(error);
		if (failure === 'completion read') {
			env.capture.mockResolvedValue(durable());
			env.getSession.mockImplementation(async () => {
				if (env.getSession.mock.calls.length % 2 === 0) throw error;
				return env.session;
			});
		}
		await env.save();
		const work = env.background.runAll();
		await vi.runAllTimersAsync();
		await work;
		expect(env.background.labels).toHaveLength(4);
		expect(
			env.metrics.increment.mock.calls.filter(([name]) => name === 'sessions.save.hint_failed'),
		).toHaveLength(4);
		expect(vi.getTimerCount()).toBe(0);
		env.getSession.mockResolvedValue(env.session);
		env.capture.mockResolvedValue(failedCapture(false));
		await env.save();
		expect(env.background.pending()).toBe(1);
		await env.background.runAll();
	},
);

it.each(['failed', 'uncertain'] as const)(
	'does not spin on nonretryable %s captures',
	async (status) => {
		const env = fixture();
		env.capture.mockResolvedValue(failedCapture(false, status));
		await env.save();
		await env.background.runAll();
		expect(env.capture).toHaveBeenCalledOnce();
		expect(env.background.labels).toHaveLength(1);
	},
);

it('persists saves during backoff and captures their latest generation', async () => {
	vi.useFakeTimers();
	const env = fixture();
	const newer = {
		...env.session,
		save_dirty: { id: crypto.randomUUID(), acknowledged_at: new Date().toISOString() },
	};
	env.capture.mockResolvedValueOnce(failedCapture(true)).mockResolvedValue(failedCapture(false));
	await env.save();
	const work = env.background.runAll();
	await vi.advanceTimersByTimeAsync(50);
	env.acknowledge.mockResolvedValue(newer);
	env.getSession.mockResolvedValue(newer);
	await env.save();
	expect(env.acknowledge).toHaveBeenCalledTimes(2);
	await vi.runAllTimersAsync();
	await work;
	expect(env.capture).toHaveBeenCalledTimes(2);
	expect(env.capture.mock.calls[1][0].save_dirty).toEqual(newer.save_dirty);
});

it('does not capture a session that stops during backoff', async () => {
	vi.useFakeTimers();
	const env = fixture();
	env.capture.mockResolvedValue(failedCapture(true, 'uncertain'));
	await env.save();
	const work = env.background.runAll();
	await vi.advanceTimersByTimeAsync(50);
	env.getSession.mockResolvedValue({ ...env.session, status: 'terminating' });
	await vi.runAllTimersAsync();
	await work;
	expect(env.capture).toHaveBeenCalledOnce();
});

it('keeps persistence and scheduling functional when telemetry throws', async () => {
	const env = fixture();
	env.metrics.increment.mockImplementation(() => {
		throw new Error('exporter unavailable');
	});
	await env.save();
	await env.background.runAll();
	expect(env.acknowledge).toHaveBeenCalledOnce();
	expect(env.capture).toHaveBeenCalledOnce();
});

it('leaves overflow and abandoned queued intent discoverable by another service instance', async () => {
	const env = fixture();
	env.acknowledge.mockRestore();
	env.getSession.mockRestore();
	const ids = Array.from({ length: 65 }, () => createSessionId());
	for (const id of ids) {
		const session = { ...env.session, session_id: id, save_dirty: undefined };
		await env.deps.bucket.put(paths.session(session.project_id, id), JSON.stringify(session));
		await env.save({ sessionId: id });
	}
	expect(env.background.pending()).toBe(64);
	expect(env.capture).not.toHaveBeenCalled();
	const replica = new SessionService(env.deps.bucket);
	for (const id of ids) {
		expect((await replica.getSession(env.session.project_id, id)).save_dirty).toBeDefined();
	}
});
