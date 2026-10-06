import { kernelActiveConnections } from './kernelActiveConnections';
import type { ConnectionProbe } from './kernelActiveConnections';
import { kernelBasePathFromUrl } from './sandboxExposure';
import { sessionResourceNotebookId } from '../../sessionOrigin';
import { captureThumbnail } from './captureThumbnail';
import type { Bucket } from '../../ports/bucket';
import type { SandboxProvider } from '../../ports/sandbox';
import { sessionOwner } from './sessionOwner';
import { readStored, VersionSchema } from '../../schema';
import type { GitSource, Session } from '../../schema';
import { paths } from '../../paths';
import { Millis } from '../../duration';
import { ConflictError } from '../../errors';
import { logOperationalError } from '../../operationalLog';
import { captureFilesystemSnapshot } from '../content/filesystemSnapshots';
import type { NotebookService } from '../content/NotebookService';
import { SandboxProvisioner } from './SandboxProvisioner';
import { isTerminal, sessionPersistsEdits } from './sessionState';
import { isPastAuthorizationDeadline } from './SessionService';
import { pullSourceRootPath, sandboxWorkspaceLayout } from './workspaceLayout';
import type { SessionService, TakeoverDrainStage } from './SessionService';
import { stopSurfaceProcessCommand, surfaceCancelFile, surfacePidFile } from './surfaces/state';
import type { SurfaceId } from './surfaces/types';

export const RECLAIM_PROVISION_GRACE_MS = Millis.minutes(15);

const DEFAULT_WORKDIR = '/workspace';
const TAKEOVER_DRAIN_LEASE_RENEW_INTERVAL_MS = Millis.minutes(1);

class SecondarySurfaceStopError extends Error {
	override readonly name = 'SecondarySurfaceStopError';
}

export interface SessionRetirerDeps {
	sessions: SessionService;
	notebooks: NotebookService;
	compute: SandboxProvider;
	bucket: Bucket;
	persistWorkspace: 'source' | 'workspace';
	automaticThumbnails?: boolean;
	thumbnailDeadline?: () => number | undefined;
	workdir?: string;
	probe?: ConnectionProbe;
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

/** Centralizes capture, destruction, and claim release for session teardown. */
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
		opts: {
			teardown?: boolean;
			markTerminated?: boolean;
			captureBeforeDestroy?: boolean;
			thumbnailDeadlineAt?: number;
		} = {},
	): Promise<void> {
		if (opts.teardown === false && session.status === 'terminating') return;
		const sandboxDestroyed =
			opts.teardown === false
				? !session.sandbox_id
				: await this.teardownSandbox(
						session,
						opts.captureBeforeDestroy ?? true,
						opts.thumbnailDeadlineAt,
					);
		if (opts.markTerminated !== false) {
			await this.deps.sessions
				.markTerminated(session.project_id, session.session_id)
				.catch(() => {});
		}
		await this.deps.sessions.releaseAppFor(session);
		if (sandboxDestroyed) {
			if (opts.teardown !== false && session.sandbox_id) {
				await this.deps.sessions
					.markSandboxReclaimed(session.project_id, session.session_id, new Date().toISOString())
					.catch(() => {});
			}
			await this.deps.sessions.releaseEditorFor(session);
		}
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
		const sandbox = this.deps.compute.create(session.sandbox_id, { owner: sessionOwner(session) });
		await this.stopSecondarySurfaces(sandbox, session);
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
				await this.captureSavedArtifacts(sandbox, session);
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
	async reclaim(
		selected: Session,
		{
			save,
			thumbnailDeadlineAt,
			requireIdle = false,
		}: {
			save?: boolean;
			thumbnailDeadlineAt?: number;
			requireIdle?: boolean;
		} = {},
	): Promise<boolean> {
		const session = await this.deps.sessions.getSession(selected.project_id, selected.session_id);
		if (!isTerminal(session.status) && session.status !== 'terminating') return false;
		if (session.sandbox_reclaimed_at) {
			await this.finishReclaim(session);
			return true;
		}
		const now = Date.now();
		const stopping = session.status === 'terminating' || !!session.terminating_at;
		const ready = session.surfaces?.marimo?.status === 'ready';
		if (
			stopping &&
			now - Date.parse(session.terminating_at ?? session.last_heartbeat) <
				RECLAIM_PROVISION_GRACE_MS
		)
			return false;
		const authorized = !isPastAuthorizationDeadline(session, now);
		// An expired provision may still be restoring files. Capturing it can delete
		// workspace files that have not reached the sandbox yet.
		if (
			session.status === 'expired' &&
			authorized &&
			!ready &&
			now - Date.parse(session.started_at) < RECLAIM_PROVISION_GRACE_MS
		)
			return false;
		let capture =
			(save ?? (session.status === 'expired' || stopping)) &&
			session.status !== 'failed' &&
			(ready || !!session.sandbox_url) &&
			authorized &&
			sessionPersistsEdits(session);
		if (capture) {
			const siblings = await this.deps.sessions.listByProject(
				session.project_id,
				session.notebook_id,
			);
			capture = !siblings.some(
				(other) =>
					other.session_id !== session.session_id &&
					sessionPersistsEdits(other) &&
					(other.status === 'running' || other.status === 'starting'),
			);
		}
		const mustProbe = requireIdle && session.status === 'expired' && authorized;
		let existing: ReturnType<SandboxProvider['create']> | undefined;
		if ((capture || mustProbe) && session.sandbox_id) {
			// create().read/exec may launch a replacement when the original is gone.
			if (!this.deps.compute.connectExisting) return false;
			try {
				existing = this.deps.compute.connectExisting(session.sandbox_id, {
					owner: sessionOwner(session),
				});
			} catch (error) {
				logOperationalError(
					'session_capture_unavailable',
					{ operation: 'session.reclaim', session_id: session.session_id },
					error,
				);
				return false;
			}
		}
		if (mustProbe && existing) {
			const active = await (this.deps.probe ?? kernelActiveConnections)(
				existing,
				kernelBasePathFromUrl(session.sandbox_url),
			);
			if (active !== 0) return false;
		}
		const destroyed =
			capture && existing
				? await this.teardownSandbox(session, true, thumbnailDeadlineAt, existing)
				: await this.destroySandbox(session, existing);
		if (!destroyed) return false;
		await this.finishReclaim(session);
		return true;
	}

	private async finishReclaim(session: Session): Promise<void> {
		if (session.status === 'terminating' || session.terminating_at) {
			await this.deps.sessions
				.markTerminated(session.project_id, session.session_id)
				.catch(() => {});
		}
		if (!session.sandbox_reclaimed_at) {
			await this.deps.sessions
				.markSandboxReclaimed(session.project_id, session.session_id, new Date().toISOString())
				.catch(() => {});
		}
		await this.deps.sessions.releaseAppFor(session);
		await this.deps.sessions.releaseEditorFor(session);
	}

	/**
	 * Best-effort persistence followed by a destruction attempt. The return value
	 * fences editor-claim release until the provider confirms destruction.
	 */
	private async teardownSandbox(
		session: Session,
		captureBeforeDestroy = true,
		thumbnailDeadlineAt?: number,
		existing?: ReturnType<SandboxProvider['create']>,
	): Promise<boolean> {
		if (!session.sandbox_id) return true;
		const sandbox =
			existing ?? this.deps.compute.create(session.sandbox_id, { owner: sessionOwner(session) });
		let canCapture = captureBeforeDestroy;
		try {
			await this.stopSecondarySurfaces(sandbox, session);
		} catch (error) {
			if (!(error instanceof SecondarySurfaceStopError)) throw error;
			// A live secondary writer makes a consistent capture unsafe.
			canCapture = false;
			logOperationalError(
				'session_surface_stop_failed',
				{ operation: 'session_retire.stop_surfaces', session_id: session.session_id },
				error,
			);
		}
		let persisted = false;
		if (canCapture) {
			try {
				const persistEdits =
					sessionPersistsEdits(session) && (await this.deps.sessions.ownsEditorClaim(session));
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
				// A failed capture means this sandbox's state was not committed as a version.
				// Snapshotting it would point restores at unsaved state and delete the last good snapshot.
				logOperationalError(
					'session_capture_failed',
					{
						operation: 'session_retire.capture_session',
						project_id: session.project_id,
						notebook_id: sessionResourceNotebookId(session),
						origin: session.origin,
						session_id: session.session_id,
					},
					err,
				);
			}
		}
		if (persisted) await this.captureSavedArtifacts(sandbox, session, thumbnailDeadlineAt);
		return this.destroySandbox(session, sandbox);
	}

	private async destroySandbox(
		session: Session,
		existing?: ReturnType<SandboxProvider['create']>,
	): Promise<boolean> {
		if (!session.sandbox_id) return true;
		try {
			const sandbox =
				existing ?? this.deps.compute.create(session.sandbox_id, { owner: sessionOwner(session) });
			await sandbox.destroy();
			return true;
		} catch (err) {
			logOperationalError(
				'sandbox_destroy_failed',
				{
					operation: 'session_retire.destroy',
					project_id: session.project_id,
					notebook_id: sessionResourceNotebookId(session),
					origin: session.origin,
					session_id: session.session_id,
				},
				err,
			);
			return false;
		}
	}

	private async captureSavedArtifacts(
		sandbox: ReturnType<SandboxProvider['create']>,
		session: Session,
		thumbnailDeadlineAt?: number,
	): Promise<void> {
		if (this.deps.automaticThumbnails !== false && session.sandbox_id) {
			await captureThumbnail(
				sandbox,
				this.deps.notebooks,
				session.project_id,
				session.notebook_id,
				session.sandbox_id,
				await this.workspaceDir(session),
				Math.min(thumbnailDeadlineAt ?? Infinity, this.deps.thumbnailDeadline?.() ?? Infinity),
			);
		}
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

	/**
	 * The sandbox was provisioned with the subtree of the session's pinned
	 * version; a pull sync during the session can move the live `root_path`.
	 * Versions without `git_source` fall back to the live setting. The thumbnail
	 * is best-effort: any failure falls back to the workdir rather than blocking
	 * the sandbox destroy that follows.
	 */
	private async workspaceDir(session: Session): Promise<string | undefined> {
		const workdir = this.deps.workdir;
		try {
			const source = await this.deps.notebooks.getNotebookSource(
				session.project_id,
				session.notebook_id,
			);
			const rootPath = source.type === 'git' ? await this.pinnedRootPath(session, source) : '';
			return sandboxWorkspaceLayout(workdir ?? DEFAULT_WORKDIR, rootPath).workdir;
		} catch {
			return workdir;
		}
	}

	private async pinnedRootPath(session: Session, source: GitSource): Promise<string> {
		const live = pullSourceRootPath(source);
		if (source.sync_mode !== 'pull' || !session.source_version_id) return live;
		const meta = paths
			.project(session.project_id)
			.notebook(session.notebook_id)
			.version(session.source_version_id).meta;
		const object = await this.deps.bucket.get(meta);
		if (!object) return live;
		const version = await readStored(VersionSchema, object, meta);
		return version.git_source?.root_path ?? live;
	}

	private async stopSecondarySurfaces(
		sandbox: ReturnType<SandboxProvider['create']>,
		session: Session,
	): Promise<void> {
		const current = await this.deps.sessions.getSession(session.project_id, session.session_id);
		const surfaces = Object.entries(current.surfaces ?? {}).filter(
			([id, state]) =>
				id !== 'marimo' &&
				(state.status === 'starting' ||
					state.status === 'ready' ||
					state.status === 'stopping' ||
					state.status === 'failed'),
		);
		if (surfaces.length === 0) return;
		await Promise.all(
			surfaces.map(([id]) =>
				this.deps.sessions.beginSurfaceStop(
					session.project_id,
					session.session_id,
					id as SurfaceId,
				),
			),
		);
		const fenced = await this.deps.sessions.getSession(session.project_id, session.session_id);
		const stopped = await Promise.allSettled(
			surfaces.map(async ([id]) => {
				const surface = id as SurfaceId;
				const cancelledAttemptId = fenced.surfaces?.[id]?.cancelled_attempt_id;
				const command = stopSurfaceProcessCommand(surfacePidFile(session.session_id, surface), {
					cancelFile: cancelledAttemptId
						? surfaceCancelFile(session.session_id, surface, cancelledAttemptId)
						: undefined,
				});
				try {
					const result = await sandbox.exec(command, { timeout: 10_000 });
					if (!result.success) throw new Error(`Failed to stop ${id} before session retirement`);
				} catch (cause) {
					throw new SecondarySurfaceStopError(`Failed to stop ${id} before session retirement`, {
						cause,
					});
				}
			}),
		);
		const failure = stopped.find((result) => result.status === 'rejected');
		if (failure) throw failure.reason;
	}
}
