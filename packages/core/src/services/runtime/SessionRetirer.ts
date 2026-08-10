import type { Bucket } from '../../ports/bucket';
import type { SandboxProvider } from '../../ports/sandbox';
import type { Session } from '../../schema';
import { Millis } from '../../duration';
import { ConflictError } from '../../errors';
import { logOperationalError } from '../../operationalLog';
import { captureFilesystemSnapshot } from '../content/filesystemSnapshots';
import type { NotebookService } from '../content/NotebookService';
import { SandboxProvisioner } from './SandboxProvisioner';
import { sessionPersistsEdits } from './sessionState';
import type { SessionService, TakeoverDrainStage } from './SessionService';

const TAKEOVER_DRAIN_LEASE_RENEW_INTERVAL_MS = Millis.minutes(1);

export interface SessionRetirerDeps {
	sessions: SessionService;
	notebooks: NotebookService;
	compute: SandboxProvider;
	bucket: Bucket;
	persistWorkspace: 'source' | 'workspace';
	workdir?: string;
}

export class TakeoverRetirementError extends Error {
	readonly drainStarted: boolean;
	override readonly cause: unknown;

	constructor(cause: unknown, drainStarted: boolean) {
		super(cause instanceof Error ? cause.message : 'Could not retire the editor for takeover');
		this.name = 'TakeoverRetirementError';
		this.drainStarted = drainStarted;
		this.cause = cause;
	}
}

/**
 * The one seam through which a session ends. Every path that retires a session
 * — the DELETE route, the create route's dead-kernel retire, the lifecycle
 * reaper, sandbox reclaim, and reconciliation — goes through here, so
 * teardown-time behavior (the save decision via `sessionPersistsEdits`, the
 * terminal mark, the app-claim release) is added ONCE per feature, and
 * "forgot to release the claim on path X" is structurally impossible.
 */
export class SessionRetirer {
	private readonly provisioner: SandboxProvisioner;

	constructor(private deps: SessionRetirerDeps) {
		this.provisioner = new SandboxProvisioner(deps.compute);
	}

	/**
	 * End a session: best-effort save-and-destroy of its sandbox, mark the
	 * record terminated, and release claims whose sandbox is confirmed gone.
	 *
	 * `teardown: false` skips the sandbox work (a concurrent stop already owns
	 * the teardown — the caller lost the `beginTerminating` race). The terminal
	 * mark is best-effort: a lost CAS leaves the record `terminating` for the
	 * stale reaper to expire, which beats failing a stop whose sandbox is
	 * already gone. `markTerminated: false` is for callers whose record is
	 * already terminal (reconciliation).
	 */
	async retire(
		session: Session,
		opts: { teardown?: boolean; markTerminated?: boolean; captureBeforeDestroy?: boolean } = {},
	): Promise<void> {
		const sandboxDestroyed =
			opts.teardown === false
				? !session.sandbox_id
				: await this.teardownSandbox(session, opts.captureBeforeDestroy ?? true);
		if (opts.markTerminated !== false) {
			await this.deps.sessions
				.markTerminated(session.project_id, session.session_id)
				.catch(() => {});
		}
		await this.deps.sessions.releaseAppFor(session);
		if (sandboxDestroyed) await this.deps.sessions.releaseEditorFor(session);
	}

	/**
	 * Preserve an exclusive editor and stop it without releasing its protected
	 * claim. Winning the terminating transition first prevents a concurrent stop
	 * from capturing and destroying the same sandbox.
	 */
	async retireForTakeover(session: Session, requestedBy: Session['user_id']): Promise<void> {
		let drainStarted = false;
		try {
			const terminating = await this.deps.sessions.beginTerminating(
				session.project_id,
				session.session_id,
				{
					reason: 'takeover',
					by: requestedBy,
				},
			);
			if (!terminating.transitioned) {
				throw new ConflictError('Another request already started terminating the editor session');
			}
			drainStarted = true;
			await this.teardownForTakeover(terminating.session);
			await this.deps.sessions.markTerminated(session.project_id, session.session_id);
		} catch (err) {
			throw new TakeoverRetirementError(err, drainStarted);
		}
	}

	async completeTakeoverDrain(
		session: Session,
		takeoverId: string,
		leaseId: string,
	): Promise<boolean> {
		const acquired = await this.deps.sessions.acquireTakeoverDrainLease(
			session.project_id,
			session.notebook_id,
			takeoverId,
			leaseId,
		);
		if (!acquired) return false;
		let leaseFinished = false;
		let leaseLost = false;
		let renewalInFlight: Promise<boolean> | undefined;
		const renewLease = (): Promise<boolean> => {
			if (renewalInFlight) return renewalInFlight;
			const pending = this.deps.sessions.renewTakeoverDrainLease(
				session.project_id,
				session.notebook_id,
				takeoverId,
				leaseId,
			);
			const tracked = pending.finally(() => {
				if (renewalInFlight === tracked) renewalInFlight = undefined;
			});
			renewalInFlight = tracked;
			return tracked;
		};
		const assertLease = async (): Promise<void> => {
			if (leaseLost || !(await renewLease())) {
				leaseLost = true;
				throw new ConflictError('The takeover drain lease is no longer owned by this request');
			}
		};
		const advanceLease = async (stage: TakeoverDrainStage): Promise<void> => {
			if (
				leaseLost ||
				!(await this.deps.sessions.advanceTakeoverDrainLease(
					session.project_id,
					session.notebook_id,
					takeoverId,
					leaseId,
					stage,
				))
			) {
				leaseLost = true;
				throw new ConflictError('The takeover drain lease is no longer owned by this request');
			}
		};
		const renewalTimer = setInterval(() => {
			void renewLease()
				.then((renewed) => {
					if (!renewed) leaseLost = true;
				})
				.catch(() => {});
		}, TAKEOVER_DRAIN_LEASE_RENEW_INTERVAL_MS);
		try {
			const current = await this.deps.sessions.getSession(session.project_id, session.session_id);
			await this.teardownForTakeover(current, { assertLease, advanceLease });
			await assertLease();
			await this.deps.sessions.markTerminated(session.project_id, session.session_id);
			await this.deps.sessions.finishTakeoverDrainLease(
				session.project_id,
				session.notebook_id,
				takeoverId,
				leaseId,
			);
			leaseFinished = true;
			return true;
		} finally {
			clearInterval(renewalTimer);
			await renewalInFlight?.catch(() => {});
			if (!leaseFinished) {
				await this.deps.sessions.releaseTakeoverDrainLease(
					session.project_id,
					session.notebook_id,
					takeoverId,
					leaseId,
				);
			}
		}
	}

	private async teardownForTakeover(
		session: Session,
		lease: {
			assertLease: () => Promise<void>;
			advanceLease: (stage: TakeoverDrainStage) => Promise<void>;
		} = { assertLease: async () => {}, advanceLease: async () => {} },
	): Promise<void> {
		if (!session.sandbox_id || session.sandbox_reclaimed_at) return;
		const sandbox = this.deps.compute.create(session.sandbox_id);
		if (!session.takeover_capture_completed_at) {
			const persisted = await this.provisioner.captureSession(
				sandbox,
				this.deps.notebooks,
				this.deps.bucket,
				session.project_id,
				session.notebook_id,
				session.user_id,
				this.deps.persistWorkspace,
				this.deps.workdir,
				{ persistEdits: true },
			);
			await lease.assertLease();
			if (persisted) {
				await lease.advanceLease('snapshotting');
				await captureFilesystemSnapshot(
					this.deps.compute,
					this.deps.notebooks,
					sandbox,
					session.project_id,
					session.notebook_id,
					{
						compute_profile: session.compute_profile,
						compute_resources: session.compute_resources,
						owner_user_id: session.user_id,
					},
				);
				await lease.assertLease();
			}
			await this.deps.sessions.markTakeoverCaptureCompleted(
				session.project_id,
				session.session_id,
				new Date().toISOString(),
			);
			await lease.advanceLease('destroying');
		} else {
			await lease.advanceLease('destroying');
		}
		await lease.assertLease();
		await sandbox.destroy();
		await lease.assertLease();
		await this.deps.sessions.markSandboxReclaimed(
			session.project_id,
			session.session_id,
			new Date().toISOString(),
		);
		await lease.advanceLease('finalizing');
	}

	/**
	 * Reclaim the sandbox behind an already-terminal record: save first when the
	 * content is still authoritative (`save`), then destroy. A failed destroy
	 * leaves the marker and claims untouched so the next sweep retries. Returns
	 * whether the sandbox is confirmed gone.
	 */
	async reclaim(session: Session, save: boolean): Promise<boolean> {
		if (save) {
			if (!(await this.teardownSandbox(session))) return false;
		} else if (session.sandbox_id) {
			try {
				await this.deps.compute.create(session.sandbox_id).destroy();
			} catch {
				return false;
			}
		}
		await this.deps.sessions
			.markSandboxReclaimed(session.project_id, session.session_id, new Date().toISOString())
			.catch(() => {});
		await this.deps.sessions.releaseAppFor(session);
		await this.deps.sessions.releaseEditorFor(session);
		return true;
	}

	/**
	 * Best-effort persistence followed by a destruction attempt. The return value
	 * fences editor-claim release until the provider confirms destruction.
	 */
	private async teardownSandbox(session: Session, captureBeforeDestroy = true): Promise<boolean> {
		if (!session.sandbox_id) return true;
		const sandbox = this.deps.compute.create(session.sandbox_id);
		let persisted = false;
		if (captureBeforeDestroy) {
			try {
				const persistEdits =
					sessionPersistsEdits(session) && (await this.deps.sessions.ownsEditorClaim(session));
				persisted = persistEdits;
				persisted = await this.provisioner.captureSession(
					sandbox,
					this.deps.notebooks,
					this.deps.bucket,
					session.project_id,
					session.notebook_id,
					session.user_id,
					this.deps.persistWorkspace,
					this.deps.workdir,
					{ persistEdits },
				);
			} catch (err) {
				logOperationalError(
					'session_capture_failed',
					{
						operation: 'session_retire.capture_session',
						project_id: session.project_id,
						notebook_id: session.notebook_id,
						session_id: session.session_id,
					},
					err,
				);
			}
		}
		if (persisted) {
			await captureFilesystemSnapshot(
				this.deps.compute,
				this.deps.notebooks,
				sandbox,
				session.project_id,
				session.notebook_id,
				{
					compute_profile: session.compute_profile,
					compute_resources: session.compute_resources,
					owner_user_id: session.user_id,
				},
			);
		}
		try {
			await sandbox.destroy();
			return true;
		} catch (err) {
			logOperationalError(
				'sandbox_destroy_failed',
				{
					operation: 'session_retire.destroy',
					project_id: session.project_id,
					notebook_id: session.notebook_id,
					session_id: session.session_id,
				},
				err,
			);
			return false;
		}
	}
}
