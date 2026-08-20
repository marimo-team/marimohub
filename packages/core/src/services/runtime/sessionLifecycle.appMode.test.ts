import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, createSandboxId } from '../../ids';
import { paths } from '../../paths';
import type { SandboxInstance } from '../../ports/sandbox';
import type { Session } from '../../schema';
import {
	appClaimHolder,
	fakeComputeFrom,
	makeFakeSandbox,
	makeLocalSource,
	makeSession,
	MemoryBucket,
} from '../../testing';
import type { SandboxCalls } from '../../testing';
import { CatalogService } from '../catalog/CatalogService';
import { NotebookService } from '../content/NotebookService';
import { kernelActiveConnections, SessionLifecycleService } from './sessionLifecycle';
import type { SessionLifecycleConfig } from './sessionLifecycle';
import { SessionService } from './SessionService';

const CFG: SessionLifecycleConfig = {
	idleTimeoutMs: 30 * 60 * 1000,
	snapshotIntervalMs: 2 * 60 * 1000,
	extensionMs: 30 * 60 * 1000,
	connectionAware: true,
	persistWorkspace: 'source',
};

describe('SessionLifecycleService (app sessions)', () => {
	let bucket: MemoryBucket;
	let sessions: SessionService;
	let notebooks: NotebookService;
	let sandboxCalls: SandboxCalls;
	let compute: ReturnType<typeof fakeComputeFrom>;
	let probe: ReturnType<typeof vi.fn>;

	const projectId = createProjectId();
	const notebookId = createNotebookId();
	const sandboxId = createSandboxId();
	const now = Date.now();
	const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

	beforeEach(() => {
		bucket = new MemoryBucket();
		sessions = new SessionService(bucket);
		notebooks = new NotebookService(bucket, new CatalogService(bucket));
		vi.spyOn(notebooks, 'getNotebook').mockResolvedValue({ source: makeLocalSource() } as never);
		vi.spyOn(notebooks, 'commitSession').mockResolvedValue(null);
		const fake = makeFakeSandbox();
		sandboxCalls = fake.calls;
		compute = fakeComputeFrom(fake.instance);
		probe = vi.fn(async () => 0);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const makeService = (overrides: Partial<SessionLifecycleConfig> = {}) =>
		new SessionLifecycleService(
			sessions,
			notebooks,
			compute,
			bucket,
			{ ...CFG, ...overrides },
			probe as (sandbox: SandboxInstance) => Promise<number | null>,
		);

	async function putSession(overrides: Partial<Session> = {}): Promise<Session> {
		const session = makeSession({
			project_id: projectId,
			notebook_id: notebookId,
			sandbox_id: sandboxId,
			mode: 'app',
			started_at: iso(-60 * 60 * 1000),
			last_heartbeat: iso(0),
			...overrides,
		});
		await bucket.put(
			paths.session(session.project_id, session.session_id),
			JSON.stringify(session),
		);
		return session;
	}

	const getStored = (s: Session) => sessions.getSession(s.project_id, s.session_id);

	it('reaps an idle app with persistence skipped and releases the claim', async () => {
		const s = await putSession({ last_heartbeat: iso(-CFG.idleTimeoutMs - 1000) });
		await bucket.put(
			paths.appClaim(projectId, notebookId),
			JSON.stringify({ session_id: s.session_id, claimed_at: iso(0) }),
		);

		const result = await makeService().sweep(now);

		expect(result.reapedIdle).toBe(1);
		expect(sandboxCalls.destroy).toBe(1);
		expect(notebooks.commitSession).not.toHaveBeenCalled();
		expect((await getStored(s)).status).toBe('terminated');
		expect(await appClaimHolder(bucket, projectId, notebookId)).toBeNull();
	});

	it('never snapshots an app session (and never stamps last_snapshot_at)', async () => {
		const s = await putSession({ last_snapshot_at: iso(-10 * 60 * 1000) });

		const result = await makeService().sweep(now);

		expect(result.snapshotted).toBe(0);
		expect(notebooks.commitSession).not.toHaveBeenCalled();
		expect((await getStored(s)).last_snapshot_at).toBe(s.last_snapshot_at);
	});

	it('stamps the probed connection count onto a running app', async () => {
		probe.mockResolvedValue(4);
		const s = await putSession({ last_snapshot_at: iso(0) });

		await makeService().sweep(now);

		const stored = await getStored(s);
		expect(stored.active_connections).toBe(4);
		expect(stored.connections_checked_at).toBe(iso(0));
		expect(stored.status).toBe('running');
	});

	it('skips the stamp when the count is unchanged (no CAS churn)', async () => {
		probe.mockResolvedValue(2);
		const s = await putSession({ active_connections: 2, connections_checked_at: iso(-60_000) });

		await makeService().sweep(now);

		expect((await getStored(s)).connections_checked_at).toBe(iso(-60_000));
	});

	it('refreshes informational connection counts at most every five minutes', async () => {
		await putSession();
		const service = makeService();

		await service.sweep(now);
		await service.sweep(now + 60_000);
		await service.sweep(now + 5 * 60_000);

		expect(probe).toHaveBeenCalledTimes(2);
	});

	it('probes immediately when a reap decision becomes due', async () => {
		await putSession({ expires_at: iso(30_000) });
		const service = makeService();

		await service.sweep(now);
		await service.sweep(now + 60_000);

		expect(probe).toHaveBeenCalledTimes(2);
	});

	it('probes under the kernel base path recovered from the client URL', async () => {
		await putSession({ sandbox_url: 'https://hub.example/proxy/tok-abc/' });
		await putSession({
			notebook_id: createNotebookId(),
			sandbox_url: 'https://sb-xyz.sandbox.example/',
		});

		await makeService().sweep(now);

		const basePaths = probe.mock.calls.map(([, basePath]) => basePath as string);
		expect(basePaths.toSorted((a, b) => a.localeCompare(b))).toEqual(['', '/proxy/tok-abc']);
	});

	it('kernelActiveConnections requests the status endpoint under the base path', async () => {
		const fake = makeFakeSandbox();
		await kernelActiveConnections(fake.instance, '/proxy/tok-abc');
		await kernelActiveConnections(fake.instance);

		expect(fake.calls.exec[0]).toContain(
			'http://127.0.0.1:2718/proxy/tok-abc/api/status/connections',
		);
		expect(fake.calls.exec[1]).toContain('http://127.0.0.1:2718/api/status/connections');
	});

	it('leaves the stamp alone on a null probe (unknown, not zero)', async () => {
		probe.mockResolvedValue(null);
		const s = await putSession({ active_connections: 2, connections_checked_at: iso(-60_000) });

		await makeService().sweep(now);

		const stored = await getStored(s);
		expect(stored.active_connections).toBe(2);
		expect(stored.connections_checked_at).toBe(iso(-60_000));
	});

	it('null probe + fresh heartbeat never reaps a running app', async () => {
		probe.mockResolvedValue(null);
		const s = await putSession({ expires_at: iso(-1000) });

		const result = await makeService().sweep(now);

		expect(result.reapedExpired).toBe(0);
		expect(result.extended).toBe(1);
		expect((await getStored(s)).status).toBe('running');
	});

	it('a running app never suppresses the save of an expired edit session on its notebook', async () => {
		// Only live PERSISTING sessions mark a notebook "superseded" (save-
		// suppressed). The app never writes back — counting it would silently
		// discard the expired editor's work while anyone has the app open.
		await putSession();
		await putSession({
			mode: 'edit',
			sandbox_id: createSandboxId(),
			status: 'expired',
			started_at: iso(-60 * 60 * 1000),
			last_heartbeat: iso(-60 * 60 * 1000),
		});

		const result = await makeService().sweep(now);

		expect(notebooks.commitSession).toHaveBeenCalledTimes(1);
		expect(result.reclaimed).toBe(1);
	});

	it('reaps an expired app record without saving (reclaim skips persistence)', async () => {
		const s = await putSession({
			status: 'expired',
			started_at: iso(-60 * 60 * 1000),
			last_heartbeat: iso(-60 * 60 * 1000),
		});

		const result = await makeService().sweep(now);

		expect(result.reclaimed).toBe(1);
		expect(sandboxCalls.destroy).toBe(1);
		expect(notebooks.commitSession).not.toHaveBeenCalled();
		expect((await getStored(s)).sandbox_reclaimed_at).toBeDefined();
	});
});
