import { afterEach, expect, it, vi } from 'vitest';
import {
	createProjectId,
	createSessionId,
	createSandboxId,
	createNotebookId,
	SessionCaptureCoordinator,
} from '@marimo-hub/core';
import { ACTOR, makeSession, makeFakeCompute, MemoryBucket } from '@marimo-hub/core/testing';
import { queuedBackgroundWork } from '@marimo-hub/core/testing/background-work';
import { observeRuntimeSave } from './sandboxProxy';
import { makeTestDeps } from './testing';

afterEach(() => vi.restoreAllMocks());
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
	const capture = vi.spyOn(SessionCaptureCoordinator.prototype, 'capture').mockResolvedValue({
		critical: {
			status: 'failed',
			code: 'SOURCE_UNAVAILABLE',
			retryable: true,
			cause: new Error('bucket unavailable'),
		},
		workspace: { status: 'skipped' },
		runtimeState: 'running',
	});
	const request = new Request('https://hub.test/proxy/token/api/kernel/save', { method: 'POST' });
	const response = new Response('native acknowledgement');
	const decision = {
		kind: 'forward' as const,
		projectId,
		sessionId,
		targetUrl: 'http://runtime/api/kernel/save',
	};
	return { deps, background, acknowledge, capture, request, response, decision };
}

it('returns without waiting for storage or buffering the native acknowledgement, even with inline background work', async () => {
	const env = fixture();
	const release = Promise.withResolvers<void>();
	let work: Promise<unknown> | undefined;
	env.deps.backgroundWork = {
		defer: (_label, task) => {
			work = task();
			return work.then(() => {});
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
		await observeRuntimeSave(env.deps, env.request, env.response, env.decision);
		expect(env.response.bodyUsed).toBe(false);
		expect(await env.response.text()).toBe('native acknowledgement');
		expect(env.capture).not.toHaveBeenCalled();
	} finally {
		release.resolve();
		await work;
	}
});

it('coalesces a burst and retains a newer dirty acknowledgement for the periodic floor', async () => {
	const env = fixture();
	await Promise.all(
		Array.from({ length: 30 }, () =>
			observeRuntimeSave(env.deps, env.request, env.response, env.decision),
		),
	);
	expect(env.acknowledge).not.toHaveBeenCalled();
	await env.background.runAll();
	expect(env.capture).toHaveBeenCalledOnce();
	expect(env.acknowledge).toHaveBeenCalledTimes(2);
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
		await observeRuntimeSave(env.deps, env.request, env.response, {
			...env.decision,
			sessionId: createSessionId(),
		});
	await env.background.runAll();
	expect(env.capture).toHaveBeenCalledTimes(64);
});
