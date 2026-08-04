import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, createSandboxId } from '../../ids';
import { paths } from '../../paths';
import type { SandboxInstance } from '../../ports/sandbox';
import type { Session } from '../../schema';
import {
	fakeComputeFrom,
	makeFakeSandbox,
	makeLocalSource,
	makeSession,
	MemoryBucket,
} from '../../testing';
import type { SandboxCalls } from '../../testing';
import { CatalogService } from '../catalog/CatalogService';
import { NotebookService } from '../content/NotebookService';
import { SandboxProvisioner } from './SandboxProvisioner';
import { kernelActiveConnections, SessionLifecycleService } from './sessionLifecycle';
import type { SessionLifecycleConfig } from './sessionLifecycle';
import { SessionService } from './SessionService';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SNAPSHOT_INTERVAL_MS = 2 * 60 * 1000;
const EXTENSION_MS = 30 * 60 * 1000;

const CFG: SessionLifecycleConfig = {
	idleTimeoutMs: IDLE_TIMEOUT_MS,
	snapshotIntervalMs: SNAPSHOT_INTERVAL_MS,
	extensionMs: EXTENSION_MS,
	connectionAware: true,
	persistWorkspace: 'source',
};

describe('SessionLifecycleService', () => {
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
		// The sweep saves through the real captureSession path; stub the notebook
		// metadata (local source → session edits persist) and the commit so these
		// tests don't need a populated catalog (the save wiring itself is covered
		// by the SandboxProvisioner tests).
		vi.spyOn(notebooks, 'getNotebook').mockResolvedValue({ source: makeLocalSource() } as never);
		vi.spyOn(notebooks, 'commitSession').mockResolvedValue(null);
		const fake = makeFakeSandbox();
		sandboxCalls = fake.calls;
		compute = fakeComputeFrom(fake.instance);
		probe = vi.fn(async () => 0);
	});

	afterEach(() => {
		// Restore prototype spies (e.g. SandboxProvisioner.teardown) so a per-test
		// mock never leaks into a sibling; beforeEach re-establishes the fixtures.
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

	/** Write a fully-formed session record directly (statuses/timestamps at will). */
	async function putSession(overrides: Partial<Session> = {}): Promise<Session> {
		const session = makeSession({
			project_id: projectId,
			notebook_id: notebookId,
			sandbox_id: sandboxId,
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

	describe('lifetime deadline', () => {
		it('reaps a session past its deadline with no editors (save + destroy + terminated)', async () => {
			const s = await putSession({ expires_at: iso(-1000), last_snapshot_at: iso(0) });

			const result = await makeService().sweep(now);

			expect(result.reapedExpired).toBe(1);
			expect(sandboxCalls.destroy).toBe(1);
			expect(notebooks.commitSession).toHaveBeenCalled(); // saved before destroy
			expect((await getStored(s)).status).toBe('terminated');
		});

		it('extends the deadline instead of reaping while editors are connected', async () => {
			probe.mockResolvedValue(2);
			const authorizationExpiresAt = iso(60 * 60 * 1000);
			const s = await putSession({
				expires_at: iso(-1000),
				authorization_expires_at: authorizationExpiresAt,
				last_snapshot_at: iso(0),
			});

			const result = await makeService().sweep(now);

			expect(result.extended).toBe(1);
			expect(result.reapedExpired).toBe(0);
			expect(sandboxCalls.destroy).toBe(0);
			const stored = await getStored(s);
			expect(stored.status).toBe('running');
			expect(stored.expires_at).toBe(iso(EXTENSION_MS));
			expect(stored.authorization_expires_at).toBe(authorizationExpiresAt);
		});

		it('destroys an entitlement-authorized kernel at its deadline despite active connections', async () => {
			probe.mockResolvedValue(2);
			const s = await putSession({
				sandbox_url: 'https://kernel.example.com/',
				expires_at: iso(60 * 60 * 1000),
				authorization_expires_at: iso(-1000),
				last_snapshot_at: iso(0),
			});

			const result = await makeService().sweep(now);

			expect(probe).toHaveBeenCalled();
			expect(result.extended).toBe(0);
			expect(result.reapedExpired).toBe(1);
			expect(sandboxCalls.destroy).toBe(1);
			expect(notebooks.commitSession).not.toHaveBeenCalled();
			expect((await getStored(s)).status).toBe('terminated');
		});

		it('extends (not reaps) on a null probe while the heartbeat is fresh', async () => {
			// A probe hiccup is "unknown", not "no editors" — never kill a possibly
			// live editor at the deadline on a transient exec failure.
			probe.mockResolvedValue(null);
			const s = await putSession({ expires_at: iso(-1000), last_snapshot_at: iso(0) });

			const result = await makeService().sweep(now);

			expect(result.extended).toBe(1);
			expect(result.reapedExpired).toBe(0);
			expect(sandboxCalls.destroy).toBe(0);
			expect((await getStored(s)).status).toBe('running');
		});

		it('reaps on a null probe once the heartbeat is also stale (kernel dead)', async () => {
			probe.mockResolvedValue(null);
			await putSession({
				expires_at: iso(-1000),
				last_heartbeat: iso(-IDLE_TIMEOUT_MS - 1000),
				last_snapshot_at: iso(0),
			});

			const result = await makeService().sweep(now);

			expect(result.reapedIdle).toBe(1);
			expect(sandboxCalls.destroy).toBe(1);
		});

		it('no-ops when an explicit stop wins the beginTerminating race', async () => {
			const s = await putSession({ expires_at: iso(-1000), last_snapshot_at: iso(0) });
			vi.spyOn(sessions, 'beginTerminating').mockResolvedValue({
				session: { ...s, status: 'terminated' },
				transitioned: false,
			});

			const result = await makeService().sweep(now);

			expect(result.reapedExpired).toBe(0);
			expect(sandboxCalls.destroy).toBe(0);
		});

		it('reaps on schedule without probing when connectionAware is off', async () => {
			await putSession({ expires_at: iso(-1000), last_snapshot_at: iso(0) });

			const result = await makeService({ connectionAware: false }).sweep(now);

			expect(probe).not.toHaveBeenCalled();
			expect(result.reapedExpired).toBe(1);
			expect(sandboxCalls.destroy).toBe(1);
		});

		it('destroys and still marks terminated when the live save throws', async () => {
			// A failed save must not prevent the destruction attempt.
			const captureSpy = vi
				.spyOn(SandboxProvisioner.prototype, 'captureSession')
				.mockRejectedValue(new Error('save failed'));
			const s = await putSession({ expires_at: iso(-1000), last_snapshot_at: iso(0) });

			const result = await makeService().sweep(now);

			expect(captureSpy).toHaveBeenCalled();
			expect(result.reapedExpired).toBe(1);
			expect(sandboxCalls.destroy).toBe(1);
			expect((await getStored(s)).status).toBe('terminated');
		});
	});

	describe('ephemeral (viewer) sessions', () => {
		it('reaps at the deadline WITHOUT saving — destroy only', async () => {
			const s = await putSession({
				ephemeral: true,
				expires_at: iso(-1000),
				last_snapshot_at: iso(0),
			});

			const result = await makeService().sweep(now);

			expect(result.reapedExpired).toBe(1);
			expect(sandboxCalls.destroy).toBe(1);
			expect(notebooks.commitSession).not.toHaveBeenCalled();
			expect((await getStored(s)).status).toBe('terminated');
		});

		it('reclaims an expired record without saving', async () => {
			await putSession({
				ephemeral: true,
				status: 'expired',
				last_heartbeat: iso(-10 * 60 * 1000),
			});

			const result = await makeService().sweep(now);

			expect(result.reclaimed).toBe(1);
			expect(sandboxCalls.destroy).toBe(1);
			expect(notebooks.commitSession).not.toHaveBeenCalled();
		});
	});

	describe('idle reaping', () => {
		it('reaps a stale-heartbeat session with no editors', async () => {
			const s = await putSession({
				last_heartbeat: iso(-IDLE_TIMEOUT_MS - 1000),
				last_snapshot_at: iso(0),
			});

			const result = await makeService().sweep(now);

			expect(result.reapedIdle).toBe(1);
			expect(sandboxCalls.destroy).toBe(1);
			expect((await getStored(s)).status).toBe('terminated');
		});

		it('keeps a stale session alive while editors are connected', async () => {
			probe.mockResolvedValue(1);
			const s = await putSession({
				last_heartbeat: iso(-IDLE_TIMEOUT_MS - 1000),
				last_snapshot_at: iso(0),
			});

			const result = await makeService().sweep(now);

			expect(result.reapedIdle).toBe(0);
			expect(sandboxCalls.destroy).toBe(0);
			expect((await getStored(s)).status).toBe('running');
		});

		it('never probes or reaps a healthy session (fresh heartbeat, before deadline)', async () => {
			const s = await putSession({
				started_at: iso(-1000),
				expires_at: iso(60 * 60 * 1000),
				editor_sandbox_sharing: 'exclusive',
			});

			await makeService().sweep(now);

			expect(probe).not.toHaveBeenCalled();
			expect(sandboxCalls.destroy).toBe(0);
			expect((await getStored(s)).status).toBe('running');
		});

		it('stamps connections for a legacy persistent editor using the shared default', async () => {
			probe.mockResolvedValue(3);
			const s = await putSession({
				expires_at: iso(60 * 60 * 1000),
				editor_sandbox_sharing: undefined,
			});

			await makeService().sweep(now);

			expect(probe).toHaveBeenCalledOnce();
			expect(await getStored(s)).toMatchObject({
				active_connections: 3,
				connections_checked_at: iso(0),
			});
		});

		it('does not probe a healthy ephemeral editor for shared connection status', async () => {
			await putSession({
				ephemeral: true,
				expires_at: iso(60 * 60 * 1000),
				editor_sandbox_sharing: undefined,
			});

			await makeService().sweep(now);

			expect(probe).not.toHaveBeenCalled();
		});
	});

	describe('terminal-record reclaim', () => {
		it('saves + destroys the lingering sandbox of an expired record, exactly once', async () => {
			const s = await putSession({ status: 'expired', last_heartbeat: iso(-10 * 60 * 1000) });
			const svc = makeService();

			const first = await svc.sweep(now);
			expect(first.reclaimed).toBe(1);
			expect(sandboxCalls.destroy).toBeGreaterThanOrEqual(1);
			expect(notebooks.commitSession).toHaveBeenCalled();
			const stored = await getStored(s);
			expect(stored.status).toBe('expired'); // terminal statuses are sticky
			expect(stored.sandbox_reclaimed_at).toBeDefined();

			const destroysAfterFirst = sandboxCalls.destroy;
			const second = await svc.sweep(now);
			expect(second.reclaimed).toBe(0);
			expect(sandboxCalls.destroy).toBe(destroysAfterFirst); // no second teardown
		});

		it('does not stamp the reclaim marker when the destroy fails (retried next sweep)', async () => {
			const failing = {
				...makeFakeSandbox().instance,
				readFile: async () => ({ success: false as const, content: '' }),
				listFiles: async () => ({ success: false as const, files: [] }),
				destroy: async () => {
					throw new Error('compute API down');
				},
			} as unknown as SandboxInstance;
			const s = await putSession({ status: 'expired', last_heartbeat: iso(-10 * 60 * 1000) });

			const svc = new SessionLifecycleService(
				sessions,
				notebooks,
				fakeComputeFrom(failing),
				bucket,
				CFG,
				probe as (sandbox: SandboxInstance) => Promise<number | null>,
			);
			const result = await svc.sweep(now);

			expect(result.reclaimed).toBe(0);
			expect((await getStored(s)).sandbox_reclaimed_at).toBeUndefined();
		});

		it('confirm-destroys a terminated record still holding a sandbox, without probe or save', async () => {
			const s = await putSession({ status: 'terminated' });

			const result = await makeService().sweep(now);

			expect(probe).not.toHaveBeenCalled();
			expect(notebooks.commitSession).not.toHaveBeenCalled();
			expect(sandboxCalls.destroy).toBe(1);
			expect(result.reclaimed).toBe(0); // routine confirm, not a recovered leak
			expect((await getStored(s)).sandbox_reclaimed_at).toBeDefined();
		});

		it('leaves a fresh expired record alone (provision may still be restoring files)', async () => {
			const s = await putSession({
				status: 'expired',
				started_at: iso(-6 * 60 * 1000),
				last_heartbeat: iso(-6 * 60 * 1000),
			});

			const result = await makeService().sweep(now);

			expect(result.reclaimed).toBe(0);
			expect(sandboxCalls.destroy).toBe(0);
			expect((await getStored(s)).sandbox_reclaimed_at).toBeUndefined();
		});

		it('authorization expiry overrides active editors and the provision-reclaim grace', async () => {
			probe.mockResolvedValue(3);
			const s = await putSession({
				status: 'expired',
				started_at: iso(-6 * 60 * 1000),
				last_heartbeat: iso(-6 * 60 * 1000),
				authorization_expires_at: iso(-1000),
			});

			const result = await makeService().sweep(now);

			expect(result.reclaimed).toBe(1);
			expect(sandboxCalls.destroy).toBe(1);
			expect(notebooks.commitSession).not.toHaveBeenCalled();
			expect((await getStored(s)).sandbox_reclaimed_at).toBeDefined();
		});

		it('destroys WITHOUT saving when a newer live session owns the notebook', async () => {
			// The old sandbox's content is stale by definition — committing it would
			// clobber the live session's head version.
			const s = await putSession({ status: 'expired', last_heartbeat: iso(-10 * 60 * 1000) });
			await putSession({
				status: 'running',
				sandbox_id: createSandboxId(),
				last_snapshot_at: iso(0),
			});

			const result = await makeService().sweep(now);

			expect(result.reclaimed).toBe(1);
			expect(notebooks.commitSession).not.toHaveBeenCalled();
			expect((await getStored(s)).sandbox_reclaimed_at).toBeDefined();
		});

		it('spares an expired record with editors, but never snapshots it once superseded', async () => {
			probe.mockResolvedValue(1);
			const s = await putSession({ status: 'expired', last_heartbeat: iso(-10 * 60 * 1000) });
			await putSession({
				status: 'running',
				sandbox_id: createSandboxId(),
				last_snapshot_at: iso(0),
			});

			const result = await makeService().sweep(now);

			expect(result.reclaimed).toBe(0);
			expect(sandboxCalls.destroy).toBe(0);
			expect(notebooks.commitSession).not.toHaveBeenCalled();
			expect((await getStored(s)).sandbox_reclaimed_at).toBeUndefined();
		});

		it('spares and snapshots an expired record with editors when it still owns the notebook', async () => {
			probe.mockResolvedValue(1);
			const s = await putSession({ status: 'expired', last_heartbeat: iso(-10 * 60 * 1000) });

			const result = await makeService().sweep(now);

			expect(result.reclaimed).toBe(0);
			expect(result.snapshotted).toBe(1);
			expect(sandboxCalls.destroy).toBe(0);
			const stored = await getStored(s);
			expect(stored.sandbox_reclaimed_at).toBeUndefined();
			expect(stored.last_snapshot_at).toBe(iso(0));
		});
	});

	describe('periodic snapshots', () => {
		it('saves a due session source-only and advances last_snapshot_at', async () => {
			const captureSpy = vi.spyOn(SandboxProvisioner.prototype, 'captureSession');
			const s = await putSession({
				expires_at: iso(60 * 60 * 1000),
				last_snapshot_at: iso(-SNAPSHOT_INTERVAL_MS - 1000),
			});

			const result = await makeService().sweep(now);

			expect(result.snapshotted).toBe(1);
			expect(notebooks.commitSession).toHaveBeenCalledTimes(1);
			// Source-only: the workspace mirror is refreshed at teardown, not per snapshot.
			expect(captureSpy).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.anything(),
				s.project_id,
				s.notebook_id,
				s.user_id,
				'source',
				undefined,
				{ includeWorkspace: false },
			);
			expect((await getStored(s)).last_snapshot_at).toBe(iso(0));
			expect(sandboxCalls.destroy).toBe(0);
		});

		it('falls back to started_at when the session has never been snapshotted', async () => {
			await putSession({ started_at: iso(-SNAPSHOT_INTERVAL_MS - 1000) });

			const result = await makeService().sweep(now);

			expect(result.snapshotted).toBe(1);
		});

		it('skips a session snapshotted within the interval', async () => {
			const ownsClaim = vi.spyOn(sessions, 'ownsEditorClaim');
			await putSession({ last_snapshot_at: iso(-1000) });

			const result = await makeService().sweep(now);

			expect(result.snapshotted).toBe(0);
			expect(notebooks.commitSession).not.toHaveBeenCalled();
			expect(ownsClaim).not.toHaveBeenCalled();
		});

		it('is disabled by snapshotIntervalMs = 0', async () => {
			const ownsClaim = vi.spyOn(sessions, 'ownsEditorClaim');
			await putSession({ started_at: iso(-60 * 60 * 1000) });

			const result = await makeService({ snapshotIntervalMs: 0 }).sweep(now);

			expect(result.snapshotted).toBe(0);
			expect(notebooks.commitSession).not.toHaveBeenCalled();
			expect(ownsClaim).not.toHaveBeenCalled();
		});

		it('skips a transient claim read failure without aborting other snapshots', async () => {
			const unavailable = await putSession({
				last_snapshot_at: iso(-SNAPSHOT_INTERVAL_MS - 1000),
			});
			const eligible = await putSession({
				notebook_id: createNotebookId(),
				sandbox_id: createSandboxId(),
				last_snapshot_at: iso(-SNAPSHOT_INTERVAL_MS - 1000),
			});
			vi.spyOn(sessions, 'ownsEditorClaim').mockImplementation(async (session) => {
				if (session.session_id === unavailable.session_id) throw new Error('bucket unavailable');
				return session.session_id === eligible.session_id;
			});

			const result = await makeService().sweep(now);

			expect(result.snapshotted).toBe(1);
			expect(notebooks.commitSession).toHaveBeenCalledTimes(1);
			expect((await getStored(unavailable)).last_snapshot_at).toBe(
				iso(-SNAPSHOT_INTERVAL_MS - 1000),
			);
			expect((await getStored(eligible)).last_snapshot_at).toBe(iso(0));
		});

		it('does not advance last_snapshot_at when the save fails (retried next sweep)', async () => {
			vi.mocked(notebooks.commitSession).mockRejectedValue(new Error('bucket down'));
			const s = await putSession({ last_snapshot_at: iso(-SNAPSHOT_INTERVAL_MS - 1000) });

			const result = await makeService().sweep(now);

			expect(result.snapshotted).toBe(0);
			expect((await getStored(s)).last_snapshot_at).toBe(iso(-SNAPSHOT_INTERVAL_MS - 1000));
		});

		it('never snapshots an ephemeral (viewer) session', async () => {
			await putSession({ ephemeral: true, last_snapshot_at: iso(-SNAPSHOT_INTERVAL_MS - 1000) });

			const result = await makeService().sweep(now);

			expect(result.snapshotted).toBe(0);
			expect(notebooks.commitSession).not.toHaveBeenCalled();
		});

		it('advances last_snapshot_at for a synced source (nothing to persist, checked per interval)', async () => {
			vi.mocked(notebooks.getNotebook).mockResolvedValue({
				source: { schema_version: 1, type: 'git' },
			} as never);
			const s = await putSession({ last_snapshot_at: iso(-SNAPSHOT_INTERVAL_MS - 1000) });

			const result = await makeService().sweep(now);

			expect(result.snapshotted).toBe(0);
			expect(notebooks.commitSession).not.toHaveBeenCalled();
			expect((await getStored(s)).last_snapshot_at).toBe(iso(0));
		});
	});

	describe('candidate selection', () => {
		it('ignores starting and sandboxless sessions', async () => {
			await putSession({ status: 'starting', started_at: iso(-60 * 60 * 1000) });
			await putSession({ sandbox_id: undefined, started_at: iso(-60 * 60 * 1000) });

			const result = await makeService().sweep(now);

			expect(result).toEqual({
				snapshotted: 0,
				extended: 0,
				reapedExpired: 0,
				reapedIdle: 0,
				reclaimed: 0,
			});
			expect(sandboxCalls.destroy).toBe(0);
			expect(notebooks.commitSession).not.toHaveBeenCalled();
		});
	});
});

describe('kernelActiveConnections', () => {
	const sandboxWith = (exec: SandboxInstance['exec']) => ({ exec }) as SandboxInstance;

	it('parses the active connection count', async () => {
		const sandbox = sandboxWith(async () => ({ success: true, stdout: '3\n', stderr: '' }));
		expect(await kernelActiveConnections(sandbox)).toBe(3);
	});

	it('returns null when the exec fails', async () => {
		const sandbox = sandboxWith(async () => ({ success: false, stdout: '', stderr: 'boom' }));
		expect(await kernelActiveConnections(sandbox)).toBeNull();
	});

	it('returns null on garbage output', async () => {
		const sandbox = sandboxWith(async () => ({ success: true, stdout: 'Traceback…', stderr: '' }));
		expect(await kernelActiveConnections(sandbox)).toBeNull();
	});

	it('returns null on partially numeric output', async () => {
		const sandbox = sandboxWith(async () => ({ success: true, stdout: '2garbage\n', stderr: '' }));
		expect(await kernelActiveConnections(sandbox)).toBeNull();
	});

	it('returns null on a digit run too long to be a safe integer', async () => {
		// `Number('9'.repeat(309))` is Infinity, and JSON.stringify writes that into
		// the session record as null — a value SessionSchema rejects, leaving the
		// record permanently unreadable and its sandbox invisible to every sweep.
		const sandbox = sandboxWith(async () => ({
			success: true,
			stdout: `${'9'.repeat(309)}\n`,
			stderr: '',
		}));
		expect(await kernelActiveConnections(sandbox)).toBeNull();
	});

	it('returns null when the exec throws (sandbox unreachable)', async () => {
		const sandbox = sandboxWith(async () => {
			throw new Error('unreachable');
		});
		expect(await kernelActiveConnections(sandbox)).toBeNull();
	});
});
