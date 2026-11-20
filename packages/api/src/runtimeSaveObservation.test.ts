import { afterEach, expect, it, vi } from 'vitest';
import {
	createProjectId,
	createVersionId,
	createSessionId,
	createSandboxId,
	createNotebookId,
	SessionCaptureCoordinator,
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
	const deps = makeTestDeps(new MemoryBucket(), {
		backgroundWork: background.work,
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

it('returns without waiting for storage or buffering the native acknowledgement, even with inline background work', async () => {
	vi.useFakeTimers();
	const env = fixture();
	const release = Promise.withResolvers<void>();
	const work: Promise<unknown>[] = [];
	env.deps.backgroundWork = {
		defer: (_label, task) => {
			const execution = task();
			work.push(execution);
			return execution.then(() => {});
		},
	};
	env.acknowledge.mockImplementation(async () => {
		await release.promise;
		throw new Error('bucket outage');
	});
	env.deps.metrics = {
		increment: () => {
			throw new Error('exporter failure');
		},
		gauge: () => {},
	};
	try {
		await env.save();
		expect(env.response.bodyUsed).toBe(false);
		expect(await env.response.text()).toBe('native acknowledgement');
		expect(env.capture).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await vi.runAllTimersAsync();
		const results = await Promise.allSettled(work);
		expect(results.map((result) => result.status)).toEqual([
			'fulfilled',
			'fulfilled',
			'fulfilled',
			'rejected',
		]);
		expect(work).toHaveLength(4);
	}
});

it('coalesces superseded hints before capture', async () => {
	const env = fixture();
	await Promise.all(Array.from({ length: 30 }, () => env.save()));
	expect(env.acknowledge).not.toHaveBeenCalled();
	await env.background.runAll();
	expect(env.capture).toHaveBeenCalledOnce();
	expect(env.acknowledge).toHaveBeenCalledOnce();
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
	await env.background.runAll();
	expect(env.acknowledge).not.toHaveBeenCalled();
});

it('bounds the process-local coalescer independently of notebook cardinality', async () => {
	const env = fixture();
	for (let index = 0; index < 100; index++)
		await env.save({
			sessionId: createSessionId(),
		});
	await env.background.runAll();
	expect(env.capture).toHaveBeenCalledTimes(64);
});

it('preserves observation time across queue delay and a coalesced later save', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	const env = fixture();
	const first = '2026-01-01T00:00:00.000Z';
	const next = '2026-01-01T00:00:01.000Z';
	vi.setSystemTime(new Date(first));
	await env.save();
	vi.setSystemTime(new Date(next));
	await env.save();
	vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
	await env.background.runAll();
	expect(env.acknowledge).toHaveBeenCalledExactlyOnceWith(
		env.decision.projectId,
		env.decision.sessionId,
		next,
	);
});

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

it('captures saves arriving during capture and during its completion read', async () => {
	const env = fixture();
	env.capture
		.mockImplementationOnce(async () => {
			await env.save();
			return durable();
		})
		.mockResolvedValue(durable());
	env.getSession
		.mockImplementationOnce(async () => {
			await env.save();
			return { ...env.session, save_dirty: undefined };
		})
		.mockResolvedValue({ ...env.session, save_dirty: undefined });
	await env.save();
	await env.background.runAll();
	expect(env.capture).toHaveBeenCalledTimes(2);
	expect(env.acknowledge).toHaveBeenCalledTimes(2);
});

it('bounds continuous saves and leaves the final hint dirty', async () => {
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

it('retries failures with bounded exponential backoff without clearing dirty state', async () => {
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

it.each(['terminating', 'running'] as const)(
	'rechecks %s sessions before retrying',
	async (status) => {
		vi.useFakeTimers();
		const env = fixture();
		env.capture.mockResolvedValue(failedCapture(true, 'uncertain'));
		env.getSession.mockResolvedValue({
			...env.session,
			status,
			save_dirty: status === 'running' ? undefined : env.session.save_dirty,
		});
		await env.save();
		const work = env.background.runAll();
		await vi.runAllTimersAsync();
		await work;
		expect(env.capture).toHaveBeenCalledOnce();
	},
);

it('queues follow-ups behind other sessions', async () => {
	const env = fixture();
	const otherId = createSessionId();
	const order: string[] = [];
	env.acknowledge.mockImplementation(async (_project, id) => ({ ...env.session, session_id: id }));
	env.getSession.mockResolvedValue({ ...env.session, save_dirty: undefined });
	env.capture.mockImplementation(async (session) => {
		order.push(session.session_id);
		if (order.length === 1) await env.save();
		return durable();
	});
	await env.save();
	await env.save({
		sessionId: otherId,
	});
	await env.background.runAll();
	expect(order).toEqual([env.decision.sessionId, otherId, env.decision.sessionId]);
});

it('follows newer durable dirty state even without a local hint', async () => {
	const env = fixture();
	env.capture.mockResolvedValue(durable());
	env.getSession
		.mockResolvedValueOnce(env.session)
		.mockResolvedValueOnce(env.session)
		.mockResolvedValue({ ...env.session, save_dirty: undefined });
	await env.save();
	await env.background.runAll();
	expect(env.capture).toHaveBeenCalledTimes(2);
	expect(env.acknowledge).toHaveBeenCalledOnce();
});

it('keeps the newest hint when acknowledging an older hint fails', async () => {
	vi.useFakeTimers();
	const env = fixture();
	const first = '2026-01-01T00:00:00.000Z';
	const next = '2026-01-01T00:00:01.000Z';
	vi.setSystemTime(new Date(first));
	env.acknowledge.mockImplementationOnce(async () => {
		vi.setSystemTime(new Date(next));
		await env.save();
		throw new Error('dirty record unavailable');
	});
	await env.save();
	const work = env.background.runAll();
	await vi.runAllTimersAsync();
	await work;
	expect(env.acknowledge.mock.calls.map((call) => call[2])).toEqual([first, next]);
	expect(env.capture).toHaveBeenCalledOnce();
});

it.each(['acknowledge', 'capture', 'completion read'] as const)(
	'bounds thrown %s failures and admits a later save',
	async (failure) => {
		vi.useFakeTimers();
		const env = fixture();
		const error = new Error('storage unavailable');
		if (failure === 'acknowledge') env.acknowledge.mockRejectedValue(error);
		if (failure === 'capture') env.capture.mockRejectedValue(error);
		if (failure === 'completion read') {
			env.capture.mockResolvedValue(durable());
			env.getSession.mockRejectedValue(error);
		}
		await env.save();
		const work = env.background.runAll().then(
			() => null,
			(error: unknown) => error,
		);
		await vi.runAllTimersAsync();
		expect(await work).toBe(failure === 'acknowledge' ? error : null);
		expect(env.background.labels).toHaveLength(4);
		expect(vi.getTimerCount()).toBe(0);
		env.acknowledge.mockResolvedValue(env.session);
		env.getSession.mockResolvedValue({ ...env.session, save_dirty: undefined });
		env.capture.mockResolvedValue(durable());
		const before = env.capture.mock.calls.length;
		await env.save();
		await env.background.runAll();
		expect(env.capture).toHaveBeenCalledTimes(before + 1);
	},
);

it.each(['failed', 'uncertain'] as const)(
	'does not retry a nonretryable %s result',
	async (status) => {
		const env = fixture();
		env.capture.mockResolvedValue({
			critical: {
				status,
				code: 'CAPTURE_UNSUPPORTED',
				retryable: false,
				cause: new Error('unsupported runtime'),
			},
			workspace: { status: 'skipped' },
		});
		await env.save();
		await env.background.runAll();
		expect(env.capture).toHaveBeenCalledOnce();
		expect(env.background.labels).toHaveLength(1);
	},
);

it.each(['throw', 'reject'] as const)(
	'releases admission when the background host fails to %s',
	async (failure) => {
		const env = fixture();
		env.deps.backgroundWork = {
			defer: () => {
				if (failure === 'throw') throw new Error('queue unavailable');
				return Promise.reject(new Error('queue unavailable'));
			},
		};
		await env.save();
		env.deps.backgroundWork = env.background.work;
		await env.save();
		await env.background.runAll();
		expect(env.capture).toHaveBeenCalledOnce();
	},
);

it('captures the latest hint after a save arrives during retry backoff', async () => {
	vi.useFakeTimers();
	const env = fixture();
	env.capture.mockRejectedValueOnce(new Error('runtime unavailable')).mockResolvedValue(durable());
	env.getSession.mockResolvedValue({ ...env.session, save_dirty: undefined });
	await env.save();
	const work = env.background.runAll();
	await vi.advanceTimersByTimeAsync(50);
	const at = new Date().toISOString();
	await env.save();
	await vi.runAllTimersAsync();
	await work;
	expect(env.capture).toHaveBeenCalledTimes(2);
	expect(env.acknowledge).toHaveBeenLastCalledWith(
		env.decision.projectId,
		env.decision.sessionId,
		at,
	);
});

it.each(['succeeds', 'fails'] as const)(
	'preserves a newer burst when the previous final flush %s',
	async (outcome) => {
		const env = fixture();
		env.capture.mockImplementation(async () => {
			if (env.capture.mock.calls.length <= 4) await env.save();
			return durable();
		});
		env.getSession.mockResolvedValue({ ...env.session, save_dirty: undefined });
		env.acknowledge.mockImplementation(async () => {
			if (env.acknowledge.mock.calls.length === 5) {
				await env.save();
				if (outcome === 'fails') throw new Error('final hint write failed');
			}
			return env.session;
		});
		await env.save();
		if (outcome === 'fails') {
			await expect(env.background.runAll()).rejects.toThrow('final hint write failed');
			await env.save();
			expect(env.background.pending()).toBe(1);
		}
		await env.background.runAll();
		expect(env.capture).toHaveBeenCalledTimes(5);
		expect(env.acknowledge).toHaveBeenCalledTimes(6);
	},
);

it.each(['ephemeral', 'no reconnect'] as const)(
	'skips capture for %s sessions without looping',
	async (kind) => {
		const env = fixture();
		if (kind === 'ephemeral')
			env.acknowledge.mockResolvedValue({ ...env.session, ephemeral: true });
		else env.deps.compute.connectExisting = undefined;
		await env.save();
		await env.background.runAll();
		expect(env.capture).not.toHaveBeenCalled();
		expect(env.background.labels).toHaveLength(1);
	},
);
