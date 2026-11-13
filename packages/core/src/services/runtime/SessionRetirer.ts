import type { BackgroundWork } from '../../ports/backgroundWork';
import type { Metrics } from '../../ports/metrics';
import { kernelActiveConnections } from './kernelActiveConnections';
import type { ConnectionProbe } from './kernelActiveConnections';
import { localKernelBasePath } from './sandboxExposure';
import { sessionResourceNotebookId } from '../../sessionOrigin';
import { captureThumbnail, THUMBNAIL_MAINTENANCE_BUDGET_MS } from './captureThumbnail';
import type { Bucket } from '../../ports/bucket';
import type { SandboxProvider } from '../../ports/sandbox';
import { reconnectSessionSandbox, sessionSandbox } from './sessionSandbox';
import { readStored, VersionSchema } from '../../schema';
import type { GitSource, Session } from '../../schema';
import { paths } from '../../paths';
import { Millis } from '../../duration';
import { ConflictError, NotFoundError, SessionPersistenceRequiredError } from '../../errors';
import { logOperationalError } from '../../operationalLog';
import { logEvent } from '../../logs';
import { captureFilesystemSnapshot } from '../content/filesystemSnapshots';
import type { NotebookService } from '../content/NotebookService';
import { SessionCaptureCoordinator } from './SessionCaptureCoordinator';
import { RuntimeCaptureClient } from './runtimeCapture';
import { isTerminal, sessionPersistsEdits } from './sessionState';
import { isPastAuthorizationDeadline } from './SessionService';
import { pullSourceRootPath, sandboxWorkspaceLayout } from './workspaceLayout';
import type { SessionService, TakeoverDrainStage } from './SessionService';
import { stopSurfaceProcessCommand, surfaceCancelFile, surfacePidFile } from './surfaces/state';
import type { SurfaceId } from './surfaces/types';

export const RECLAIM_PROVISION_GRACE_MS = Millis.minutes(15);
/** Leaves an in-flight stop time to finish its own capture and destroy. */
export const RECLAIM_TEARDOWN_GRACE_MS = Millis.minutes(15);

export const RECLAIM_BLOCKED_REASONS = [
	'not_terminal',
	'teardown_grace',
	'provision_grace',
	'attachment_unsupported',
	'attachment_failed',
	'kernel_active',
	'kernel_unreachable',
	'destroy_failed',
	'timeout',
	'persistence_required',
	'stop_pending',
] as const;

export type ReclaimBlockedReason = (typeof RECLAIM_BLOCKED_REASONS)[number];

export type ReclaimOutcome =
	| { reclaimed: true; saved: boolean }
	| { reclaimed: false; reason: ReclaimBlockedReason };

export interface ReclaimPlanOptions {
	/** Whether the provider can attach without creating (`connectExisting`). */
	attachmentSupported: boolean;
	save?: boolean;
	requireIdle?: boolean;
	/** A live persisting editor on the notebook owns the content, so this sandbox must not save. */
	superseded?: boolean;
}

function isStopping(session: Session): boolean {
	return session.status === 'terminating' || !!session.terminating_at;
}

/**
 * An older sandbox on a notebook with one of these must never commit over it.
 * App sessions never write back, so a long-lived shared app must not suppress
 * an expired editor's save.
 */
export function isLivePersistingEditor(session: Session): boolean {
	return (
		sessionPersistsEdits(session) && (session.status === 'running' || session.status === 'starting')
	);
}

function reclaimCaptures(session: Session, now: number, options: ReclaimPlanOptions): boolean {
	return (
		!options.superseded &&
		(options.save ?? (session.status === 'expired' || isStopping(session))) &&
		session.status !== 'failed' &&
		(session.surfaces?.marimo?.status === 'ready' || !!session.sandbox_url) &&
		!isPastAuthorizationDeadline(session, now) &&
		sessionPersistsEdits(session)
	);
}

function reclaimProbes(session: Session, now: number, options: ReclaimPlanOptions): boolean {
	return (
		!!options.requireIdle &&
		session.status === 'expired' &&
		!isPastAuthorizationDeadline(session, now)
	);
}

/**
 * The side-effect-free part of `SessionRetirer.reclaim`'s decision. Null means
 * reclaim may proceed; it can still be blocked by the kernel probe, attachment,
 * or destruction, which need the provider.
 */
export function reclaimBlockedReason(
	session: Session,
	now: number,
	options: ReclaimPlanOptions,
): ReclaimBlockedReason | null {
	if (!isTerminal(session.status) && session.status !== 'terminating') return 'not_terminal';
	if (session.sandbox_reclaimed_at) return null;
	if (
		isStopping(session) &&
		now - Date.parse(session.terminating_at ?? session.last_heartbeat) < RECLAIM_TEARDOWN_GRACE_MS
	)
		return 'teardown_grace';
	// An expired provision may still be restoring files. Capturing it can delete
	// workspace files that have not reached the sandbox yet. A `ready` marimo
	// surface is only set after restore completes.
	if (
		session.status === 'expired' &&
		!isPastAuthorizationDeadline(session, now) &&
		session.surfaces?.marimo?.status !== 'ready' &&
		now - Date.parse(session.started_at) < RECLAIM_PROVISION_GRACE_MS
	)
		return 'provision_grace';
	if (
		session.sandbox_id &&
		!options.attachmentSupported &&
		(reclaimCaptures(session, now, options) || reclaimProbes(session, now, options))
	)
		return 'attachment_unsupported';
	return null;
}

type ThumbnailPolicy = 'skip' | 'bounded' | 'full';

/** A deadline of 0 means "capture no thumbnail". */
const SKIP_THUMBNAIL = 0;

function thumbnailDeadline(policy: ThumbnailPolicy = 'full', at = Infinity): number {
	if (policy === 'skip') return SKIP_THUMBNAIL;
	if (policy === 'bounded') return Math.min(at, Date.now() + THUMBNAIL_MAINTENANCE_BUDGET_MS);
	return at;
}

const DEFAULT_WORKDIR = '/workspace';
const TAKEOVER_DRAIN_LEASE_RENEW_INTERVAL_MS = Millis.minutes(1);

class SecondarySurfaceStopError extends Error {
	override readonly name = 'SecondarySurfaceStopError';
}

export interface SessionRetirerDeps {
	backgroundWork?: BackgroundWork;
	metrics?: Metrics;
	sessions: SessionService;
	notebooks: NotebookService;
	compute: SandboxProvider;
	bucket: Bucket;
	persistWorkspace: 'source' | 'workspace';
	automaticThumbnails?: boolean;
	thumbnailDeadline?: () => number | undefined;
	workdir?: string;
	probe?: ConnectionProbe;
	connectionAware?: boolean;
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
	constructor(private deps: SessionRetirerDeps) {}

	async reconcileRetained(session: Session): Promise<Session> {
		if (
			!session.sandbox_id ||
			!session.stop ||
			!['retained', 'uncertain'].includes(session.stop.outcome) ||
			session.stop.runtime_state === 'running'
		)
			return session;
		const sandbox = reconnectSessionSandbox(
			this.deps.compute,
			session,
			this.deps.metrics,
			'teardown',
		);
		if (!sandbox) return session;
		const runtime = new RuntimeCaptureClient(sandbox, session.sandbox_id);
		try {
			if (session.stop.runtime_token)
				await runtime.resume({
					token: session.stop.runtime_token,
					directory: session.stop.runtime_directory!,
				});
			if ((await runtime.status()).state === 'running')
				return await this.deps.sessions.confirmRetainedRuntimeResumed(session);
		} catch {
			/* The runtime watchdog remains responsible for an unconfirmed pause. */
		}
		return session;
	}

	async stop(
		selected: Session,
		options: {
			preserveEditorClaim?: boolean;
			assertOwnership?: () => Promise<void>;
			thumbnail?: ThumbnailPolicy;
			thumbnailDeadlineAt?: number;
			existing?: ReturnType<SandboxProvider['create']>;
		} = {},
	): Promise<Session> {
		const sessions = this.deps.sessions;
		const finalize = async (current: Session) => {
			await sessions.markTerminated(current.project_id, current.session_id);
			await sessions.releaseAppFor(current);
			if (!options.preserveEditorClaim) await sessions.releaseEditorFor(current);
			return sessions.finalizeStop(current);
		};
		if (selected.stop?.outcome === 'stopped') return finalize(selected);
		const fencePublication = async () => {
			const source = await this.deps.notebooks
				.getNotebookSource(selected.project_id, selected.notebook_id)
				.catch((error) => {
					if (error instanceof NotFoundError) return null;
					throw error;
				});
			if (source?.type === 'local')
				await this.deps.notebooks.fenceSessionPublications(
					selected.project_id,
					selected.notebook_id,
				);
		};
		const leaseId = crypto.randomUUID();
		let session = await sessions.claimStop(selected, leaseId);
		if (!session) return sessions.getSession(selected.project_id, selected.session_id);
		let leaseLost = false;
		let failedCaptureReceipt: 'running' | 'unknown' | undefined;
		let missingRuntimeConfirmed = false;
		let renewal: Promise<void> | undefined;
		const renew = async () => {
			if (!(await sessions.claimStop(session!, leaseId))) leaseLost = true;
		};
		const timer = setInterval(() => {
			renewal ??= renew()
				.catch(() => {
					leaseLost = true;
				})
				.finally(() => {
					renewal = undefined;
				});
		}, Millis.seconds(30));
		const update = async (patch: Parameters<SessionService['updateStop']>[2]) => {
			if (leaseLost) throw new ConflictError('The stop attempt lease was lost');
			await options.assertOwnership?.();
			session = await sessions.updateStop(session!, leaseId, patch);
		};
		const finishMissingRuntime = async () => {
			// Storage uncertainty must resume confirmed-absence cleanup, not abandon it.
			missingRuntimeConfirmed = true;
			await update({ outcome: 'stopping', runtime_state: 'stopped' });
			await fencePublication();
			await sessions.markSandboxReclaimed(
				session!.project_id,
				session!.session_id,
				new Date().toISOString(),
			);
			await update({ outcome: 'stopped', runtime_state: 'stopped' });
			return finalize(session!);
		};
		try {
			if (!session.sandbox_reclaimed_at && session.sandbox_id) {
				let sandbox: ReturnType<SandboxProvider['create']>;
				try {
					sandbox =
						options.existing ??
						reconnectSessionSandbox(this.deps.compute, session, this.deps.metrics, 'teardown') ??
						sessionSandbox(this.deps.compute, session, this.deps.metrics, 'teardown');
				} catch (error) {
					if (error instanceof NotFoundError) return await finishMissingRuntime();
					throw error;
				}
				const runtime = new RuntimeCaptureClient(sandbox, session.sandbox_id);
				if (!session.stop!.runtime_token && ['idle', 'lifetime'].includes(session.stop!.trigger)) {
					const current = await sessions.getSession(session.project_id, session.session_id);
					const eligibilityChanged =
						current.last_heartbeat !== session.stop!.eligible_heartbeat ||
						current.expires_at !== session.stop!.eligible_expires_at;
					let active: number | null = null;
					if (!eligibilityChanged && this.deps.connectionAware !== false) {
						try {
							active = await (this.deps.probe ?? kernelActiveConnections)(
								sandbox,
								localKernelBasePath(current),
							);
						} catch (error) {
							if (!(error instanceof NotFoundError)) throw error;
							return await finishMissingRuntime();
						}
					}
					if (eligibilityChanged || (active ?? 0) > 0) {
						await update({
							outcome: 'retained',
							runtime_state: 'running',
							failure: { code: 'STOP_NO_LONGER_ELIGIBLE', retryable: true },
						});
						return session;
					}
				}

				if (session.stop!.force) {
					try {
						this.deps.metrics?.increment('sessions.stop.forced', 1, {
							trigger: session.stop!.trigger,
						});
					} catch {}
					logEvent({
						level: 'warn',
						event: 'session_force_stop',
						session_id: session.session_id,
						requested_by: session.stop!.requested_by,
						trigger: session.stop!.trigger,
						attempt_id: session.stop!.id,
					});
					await fencePublication();
					await update({ outcome: 'stopping' });
				} else if (session.stop!.runtime_token) {
					// Recovery uses the token recorded before commit-stop was dispatched.
					let state: Awaited<ReturnType<RuntimeCaptureClient['status']>>;
					try {
						state = await runtime.status();
					} catch (error) {
						if (error instanceof NotFoundError) return await finishMissingRuntime();
						throw error;
					}
					if (
						state.token !== session.stop!.runtime_token ||
						!['paused', 'stopped'].includes(state.state ?? '')
					) {
						await update({
							outcome: 'retained',
							runtime_state: state.state === 'running' ? 'running' : 'unknown',
							failure: { code: 'CAPTURE_EXPIRED', retryable: true },
						});
						return session;
					}
					await runtime.commitStop({
						token: session.stop!.runtime_token,
						directory: session.stop!.runtime_directory!,
					});
					await update({ outcome: 'stopping', runtime_state: 'stopped' });
				} else if (sessionPersistsEdits(session)) {
					await update({ outcome: 'capturing' });
					await fencePublication();
					await this.stopSecondarySurfaces(sandbox, session);
					if (
						options.thumbnail &&
						options.thumbnail !== 'skip' &&
						this.deps.automaticThumbnails !== false
					) {
						await captureThumbnail(
							sandbox,
							this.deps.notebooks,
							session.project_id,
							session.notebook_id,
							session.sandbox_id,
							await this.workspaceDir(session),
							thumbnailDeadline('bounded', options.thumbnailDeadlineAt),
						).catch(() => {});
					}
					const result = await new SessionCaptureCoordinator(this.deps).capture(session, sandbox, {
						retainRuntime: true,
						assertOwnership: async () => {
							await update({});
							if (options.assertOwnership) await options.assertOwnership();
							else
								await sessions.assertCaptureOwnership(session!, {
									attemptId: session!.stop!.id,
									leaseId,
								});
						},
					});
					if (options.preserveEditorClaim && result.workspace.status === 'failed') {
						const resumed = result.runtime
							? await runtime.resume(result.runtime).then(
									() => true,
									() => false,
								)
							: result.runtimeState === 'running';
						await update({
							outcome: 'retained',
							runtime_state: resumed ? 'running' : 'unknown',
							failure: { code: 'WORKSPACE_CAPTURE_FAILED', retryable: true },
						});
						return session;
					}
					if (result.critical.status === 'failed' || result.critical.status === 'uncertain') {
						try {
							this.deps.metrics?.increment('sessions.stop.retained', 1, {
								code: result.critical.code,
								trigger: session.stop!.trigger,
							});
						} catch {}
						logOperationalError(
							'session_capture_failed',
							{
								operation: 'session.stop',
								session_id: session.session_id,
								code: result.critical.code,
							},
							result.critical.cause,
						);
						await update({
							outcome: result.critical.status === 'uncertain' ? 'uncertain' : 'retained',
							runtime_state: result.runtimeState === 'running' ? 'running' : 'unknown',
							failure: { code: result.critical.code, retryable: result.critical.retryable },
						});
						return session;
					}
					if (result.critical.status === 'durable') {
						if (!result.runtime) throw new Error('Capture did not retain its runtime checkpoint');
						try {
							await update({
								outcome: 'durable',
								runtime_token: result.runtime.token,
								runtime_directory: result.runtime.directory,
								runtime_state: 'paused',
								captured_at: result.critical.capturedAt,
								version_id: result.critical.publication.versionId,
							});
						} catch (error) {
							failedCaptureReceipt = 'unknown';
							await runtime.resume(result.runtime);
							failedCaptureReceipt = 'running';
							throw error;
						}
						await runtime.commitStop(result.runtime);
						await update({ outcome: 'stopping', runtime_state: 'stopped' });
						await this.captureSavedArtifacts(sandbox, session, SKIP_THUMBNAIL).catch(() => {});
					}
				}
				await update({ outcome: 'stopping' });
				try {
					await sandbox.destroy();
				} catch (error) {
					if (error instanceof NotFoundError) return await finishMissingRuntime();
					throw error;
				}
				await sessions.markSandboxReclaimed(
					session.project_id,
					session.session_id,
					new Date().toISOString(),
				);
			}
			await update({ outcome: 'stopped', runtime_state: 'stopped' });
			return await finalize(session);
		} catch (error) {
			logOperationalError(
				'session_stop_incomplete',
				{ operation: 'session.stop', session_id: selected.session_id },
				error,
			);
			// A recorded checkpoint/stop may already be committed. Leave its intent resumable.
			if (
				!missingRuntimeConfirmed &&
				!session.stop?.runtime_token &&
				session.stop?.outcome !== 'stopping'
			) {
				await update({
					outcome: 'uncertain',
					runtime_state: failedCaptureReceipt ?? 'unknown',
					failure: {
						code: failedCaptureReceipt ? 'CAPTURE_RECEIPT_FAILED' : 'CAPTURE_UNAVAILABLE',
						retryable: true,
					},
				}).catch(() => {});
			}
			return await sessions.getSession(selected.project_id, selected.session_id);
		} finally {
			clearInterval(timer);
			await renewal;
			await sessions.releaseStopLease(session, leaseId).catch(() => {});
		}
	}

	/** Persistent editors use durable stop attempts; discard and security cleanup skip capture. */
	async retire(
		session: Session,
		opts: {
			teardown?: boolean;
			markTerminated?: boolean;
			captureBeforeDestroy?: boolean;
			thumbnailDeadlineAt?: number;
			thumbnail?: ThumbnailPolicy;
		} = {},
	): Promise<void> {
		if (opts.teardown === false) return;
		if (sessionPersistsEdits(session) && opts.captureBeforeDestroy !== false) {
			const requested = await this.deps.sessions.requestStop(
				session.project_id,
				session.session_id,
				{ trigger: 'reconcile' },
			);
			const result = await this.stop(requested, {
				thumbnail: opts.thumbnail ?? 'bounded',
				thumbnailDeadlineAt: opts.thumbnailDeadlineAt,
			});
			if (result.stop?.outcome !== 'stopped' && !result.sandbox_reclaimed_at)
				throw new SessionPersistenceRequiredError();
			return;
		}
		const sandboxDestroyed = (
			await this.teardownSandbox(
				session,
				opts.captureBeforeDestroy ?? true,
				thumbnailDeadline(opts.thumbnail, opts.thumbnailDeadlineAt),
			)
		).destroyed;
		if (opts.markTerminated !== false) {
			await this.deps.sessions
				.markTerminated(session.project_id, session.session_id)
				.catch(() => {});
		}
		await this.deps.sessions.releaseAppFor(session);
		if (sandboxDestroyed) {
			if (session.sandbox_id) {
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
		thumbnail: ThumbnailPolicy = 'skip',
	): Promise<void> {
		if (!session.sandbox_id || session.sandbox_reclaimed_at) return;
		await lease.assertLease();
		const requested = await this.deps.sessions.requestStop(session.project_id, session.session_id, {
			trigger: 'takeover',
			...(session.stop && ['retained', 'uncertain'].includes(session.stop.outcome)
				? { key: crypto.randomUUID(), previousId: session.stop.id }
				: {}),
		});
		const result = await this.stop(requested, {
			preserveEditorClaim: true,
			thumbnail,
			assertOwnership: lease.assertLease,
		});
		await lease.assertLease();
		if (result.stop?.outcome !== 'stopped')
			throw new ConflictError('The editor could not be saved and remains retained');
		await lease.advanceLease('finalizing');
	}

	/**
	 * Reclaim the sandbox behind an already-terminal record: save first when the
	 * content is still authoritative, then destroy. Any blocked outcome leaves the
	 * marker and claims untouched so the next sweep retries.
	 */
	async reclaim(
		selected: Session,
		{
			save,
			thumbnailDeadlineAt,
			thumbnail,
			requireIdle = false,
		}: {
			save?: boolean;
			thumbnailDeadlineAt?: number;
			thumbnail?: ThumbnailPolicy;
			requireIdle?: boolean;
		} = {},
	): Promise<ReclaimOutcome> {
		const session = await this.deps.sessions.getSession(selected.project_id, selected.session_id);
		if (session.stop && !session.sandbox_reclaimed_at) {
			if (['retained', 'uncertain'].includes(session.stop.outcome)) {
				await this.reconcileRetained(session);
				return this.skipReclaim(session, 'persistence_required');
			}
			const result = await this.stop(session);
			return result.stop?.outcome === 'stopped'
				? { reclaimed: true, saved: !!result.stop.captured_at }
				: this.skipReclaim(session, 'stop_pending');
		}
		const now = Date.now();
		const options: ReclaimPlanOptions = {
			attachmentSupported: !!this.deps.compute.connectExisting,
			save,
			requireIdle,
		};
		let blocked = reclaimBlockedReason(session, now, options);
		// The sibling scan is I/O, so it runs only when its answer can change the plan.
		if (
			(blocked === null || blocked === 'attachment_unsupported') &&
			!session.sandbox_reclaimed_at &&
			reclaimCaptures(session, now, options)
		) {
			options.superseded = await this.supersededByLiveEditor(session);
			if (options.superseded) blocked = reclaimBlockedReason(session, now, options);
		}
		if (blocked) return this.skipReclaim(session, blocked);
		if (session.sandbox_reclaimed_at) {
			await this.finishReclaim(session);
			return { reclaimed: true, saved: false };
		}
		const capture = reclaimCaptures(session, now, options);
		const probe = reclaimProbes(session, now, options);
		let existing: ReturnType<SandboxProvider['create']> | undefined;
		if ((capture || probe) && session.sandbox_id) {
			// create().read/exec may launch a replacement when the original is gone.
			try {
				existing = reconnectSessionSandbox(
					this.deps.compute,
					session,
					this.deps.metrics,
					'teardown',
				);
			} catch (error) {
				if (error instanceof NotFoundError) {
					await this.finishReclaim(session);
					return { reclaimed: true, saved: false };
				}
				logOperationalError(
					'session_capture_unavailable',
					{ operation: 'session.reclaim', session_id: session.session_id },
					error,
				);
				return this.skipReclaim(session, 'attachment_failed');
			}
			if (!existing) return this.skipReclaim(session, 'attachment_unsupported');
		}
		if (probe && existing) {
			let active: number | null;
			try {
				active = await (this.deps.probe ?? kernelActiveConnections)(
					existing,
					localKernelBasePath(session),
				);
			} catch (error) {
				if (!(error instanceof NotFoundError)) throw error;
				if (!(await this.destroySandbox(session, existing))) {
					return this.skipReclaim(session, 'destroy_failed');
				}
				await this.finishReclaim(session);
				return { reclaimed: true, saved: false };
			}
			if (active === null) return this.skipReclaim(session, 'kernel_unreachable');
			if (active !== 0) return this.skipReclaim(session, 'kernel_active');
		}
		const { destroyed, saved } =
			capture && existing
				? await this.teardownSandbox(
						session,
						true,
						thumbnailDeadline(thumbnail, thumbnailDeadlineAt),
						existing,
					)
				: { destroyed: await this.destroySandbox(session, existing), saved: false };
		if (!destroyed) return this.skipReclaim(session, 'destroy_failed');
		await this.finishReclaim(session);
		return { reclaimed: true, saved };
	}

	private skipReclaim(session: Session, reason: ReclaimBlockedReason): ReclaimOutcome {
		logEvent({
			level: ['not_terminal', 'teardown_grace', 'provision_grace', 'kernel_active'].includes(reason)
				? 'info'
				: 'warn',
			event: 'session_reclaim_skipped',
			session_id: session.session_id,
			project_id: session.project_id,
			notebook_id: session.notebook_id,
			sandbox_id: session.sandbox_id,
			status: session.status,
			reason,
		});
		return { reclaimed: false, reason };
	}

	private async supersededByLiveEditor(session: Session): Promise<boolean> {
		const siblings = await this.deps.sessions.listByProject(
			session.project_id,
			session.notebook_id,
		);
		return siblings.some(
			(other) => other.session_id !== session.session_id && isLivePersistingEditor(other),
		);
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
	 * Best-effort persistence followed by a destruction attempt. `destroyed`
	 * fences editor-claim release until the provider confirms destruction.
	 */
	private async teardownSandbox(
		session: Session,
		captureBeforeDestroy = true,
		thumbnailDeadlineAt?: number,
		existing?: ReturnType<SandboxProvider['create']>,
	): Promise<{ destroyed: boolean; saved: boolean }> {
		if (!session.sandbox_id) return { destroyed: true, saved: false };
		if (captureBeforeDestroy && sessionPersistsEdits(session)) {
			const requested = await this.deps.sessions.requestStop(
				session.project_id,
				session.session_id,
				{ trigger: 'reconcile' },
			);
			const result = await this.stop(requested, {
				existing,
				thumbnail: thumbnailDeadlineAt === SKIP_THUMBNAIL ? 'skip' : 'bounded',
				thumbnailDeadlineAt,
			});
			return { destroyed: result.stop?.outcome === 'stopped', saved: !!result.stop?.captured_at };
		}
		return { destroyed: await this.destroySandbox(session, existing), saved: false };
	}

	private async destroySandbox(
		session: Session,
		existing?: ReturnType<SandboxProvider['create']>,
	): Promise<boolean> {
		if (!session.sandbox_id) return true;
		try {
			const sandbox =
				existing ?? sessionSandbox(this.deps.compute, session, this.deps.metrics, 'teardown');
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
		if (
			thumbnailDeadlineAt !== SKIP_THUMBNAIL &&
			this.deps.automaticThumbnails !== false &&
			session.sandbox_id
		) {
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
			this.deps.backgroundWork,
			this.deps.metrics,
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
