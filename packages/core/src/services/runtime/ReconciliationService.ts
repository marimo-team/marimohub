import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { Millis } from '../../duration';
import type { NotebookId, SandboxId } from '../../ids';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import type { SandboxProvider } from '../../ports/sandbox';
import { readStored } from '../../schema';
import type { Session } from '../../schema';
import type { NotebookService } from '../content/NotebookService';
import { SessionRetirer } from './SessionRetirer';
import { RECLAIM_PROVISION_GRACE_MS } from './sessionLifecycle';
import { sessionPersistsEdits } from './sessionState';
import { listAllKeys } from '../catalog/storage';
import type { SessionService } from './SessionService';

/**
 * Default age below which a recordless sandbox is left alone. Provisioning
 * writes the session record BEFORE creating the sandbox, so a live sandbox
 * always has a record unless that record was already reaped — but this window
 * is a belt-and-suspenders guard against reaping an in-flight provision.
 */
const DEFAULT_ORPHAN_GRACE_MS = Millis.minutes(15);

const OrphanMarkerSchema = z.object({ first_seen: z.number() });

export interface ReconcileResult {
	/** True when the provider can't enumerate (no `listActive`) — nothing reconciled. */
	skipped: boolean;
	/** Rule 1: terminal records whose still-running sandbox was confirmed destroyed. */
	reclaimed: number;
	/** Rule 2: live records whose sandbox had vanished, now marked terminated. */
	markedDead: number;
	/** Rule 3: live sandboxes with no record at all, destroyed. */
	orphansReaped: number;
	/** Ids of the orphan sandboxes destroyed by Rule 3 — surfaced for audit logging. */
	orphanSandboxIds: string[];
	markedDeadSessions: Session[];
}

/**
 * Reconcile session records against the compute provider's actual state.
 *
 * Sessions and sandboxes drift because provisioning a sandbox (billable) and
 * writing its session record are two non-atomic writes, and because the
 * record-only maintenance sweep (`SessionService.expireStale`/`reapTerminated`)
 * flips/deletes records without ever destroying the sandbox. This service is the
 * provider-truth safety net: it enumerates live sandboxes and cross-checks them
 * against records, in both directions.
 *
 * Depends only on `core` services and the `SandboxProvider` / `Bucket` ports —
 * never a concrete adapter — so it respects the inward dependency rule.
 */
export class ReconciliationService {
	private readonly retirer: SessionRetirer;

	constructor(
		private sessions: SessionService,
		private notebooks: NotebookService,
		private compute: SandboxProvider,
		/** Bucket handle, so save-on-reap can capture the notebook workspace. */
		private bucket: Bucket,
		/** Runtime-file persistence mode applied when save-on-reap tears a sandbox down. */
		private persistWorkspace: 'source' | 'workspace',
		/** Sandbox working dir, so save-on-reap reads the right path. See ProvisionOptions. */
		private workdir?: string,
	) {
		this.retirer = new SessionRetirer({
			sessions,
			notebooks,
			compute,
			bucket,
			persistWorkspace,
			workdir,
		});
	}

	async reconcile(opts?: { orphanGraceMs?: number }): Promise<ReconcileResult> {
		// No provider truth to reconcile against — leave the bucket sweep to do its
		// record-only job and report a clean no-op.
		if (!this.compute.listActive) {
			return {
				skipped: true,
				reclaimed: 0,
				markedDead: 0,
				orphansReaped: 0,
				orphanSandboxIds: [],
				markedDeadSessions: [],
			};
		}

		const orphanGraceMs = opts?.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
		const now = Date.now();

		// Snapshot the provider FIRST, then records — so a sandbox created mid-sweep
		// already has its (provision-time) record visible and is never mistaken for
		// an orphan.
		const active = await this.compute.listActive();
		const sessions = await this.sessions.listSessions();

		const activeIds = new Set<string>(active.map((s) => s.id));
		const recordedSandboxIds = new Set<string>();
		for (const s of sessions) {
			if (s.sandbox_id) recordedSandboxIds.add(s.sandbox_id);
		}

		// Notebooks that currently have a live PERSISTING session. An older
		// (terminal) sandbox for one of these must never commit: its content is
		// stale by definition and would clobber the live session's head version,
		// mirror-delete the workspace keys the live session wrote, and rewind the
		// FS-snapshot pointer. Same rule (and reasoning) as the lifecycle sweep.
		const liveNotebooks = new Set<NotebookId>(
			sessions
				.filter(
					(s) => (s.status === 'running' || s.status === 'starting') && sessionPersistsEdits(s),
				)
				.map((s) => s.notebook_id),
		);

		let reclaimed = 0;
		let markedDead = 0;
		let orphansReaped = 0;
		const orphanSandboxIds: string[] = [];
		const markedDeadSessions: Session[] = [];

		for (const session of sessions) {
			const sandboxId = session.sandbox_id;
			if (!sandboxId) continue;

			const isLive = session.status === 'running' || session.status === 'starting';

			if (!isLive && activeIds.has(sandboxId)) {
				// Rule 1 — record is terminal OR mid-teardown (`terminating`) but the
				// sandbox is still alive (and billing). A `terminating` record whose
				// teardown never finished would otherwise leak the sandbox forever, since
				// it is neither live (Rule 2) nor an unrecorded orphan (Rule 3). Reclaim
				// through the one seam: the record is already terminal, so this is a
				// (save-then-)destroy plus the one-shot `sandbox_reclaimed_at` stamp.

				// `expireStale()` runs immediately before this sweep, so a provision
				// slower than the heartbeat TTL arrives here `expired` while it is still
				// restoring files; tearing it down mid-restore mirror-deletes bucket keys.
				const authorizationExpired =
					session.authorization_expires_at !== undefined &&
					now >= Date.parse(session.authorization_expires_at);
				if (
					session.status === 'expired' &&
					!authorizationExpired &&
					now - Date.parse(session.started_at) < RECLAIM_PROVISION_GRACE_MS
				) {
					continue;
				}
				const save =
					!authorizationExpired &&
					!liveNotebooks.has(session.notebook_id) &&
					sessionPersistsEdits(session);
				if (await this.retirer.reclaim(session, save)) reclaimed++;
			} else if (isLive && !activeIds.has(sandboxId)) {
				// Rule 2 — live record, sandbox gone (crashed / idle-timed-out). The
				// kernel URL is dead; mark the record failed (it didn't stop cleanly) so it
				// stops being served and gets reaped on schedule.

				// A fresh `starting` record legitimately has no live sandbox yet: the saga
				// writes the record (with sandbox_id) BEFORE creating the sandbox, and a
				// cold provision can take minutes. Failing it here would strand the caller
				// on a terminal record (setRunning no-ops) with a live sandbox behind it,
				// and release the app claim mid-provision. Aged `starting` records still
				// fall through: a provision that died must eventually be marked failed.
				if (
					session.status === 'starting' &&
					now - Date.parse(session.started_at) < RECLAIM_PROVISION_GRACE_MS
				) {
					continue;
				}
				try {
					const failed = await this.sessions.markFailedWithOutcome(
						session.project_id,
						session.session_id,
					);
					if (failed.transitioned) {
						markedDead++;
						markedDeadSessions.push(session);
					}
				} catch {
					// Best-effort: the session may have been deleted concurrently.
				}
				await this.sessions.releaseAppFor(session);
			}
		}

		// Ids for which we hold (or just wrote) a first-seen marker this pass, so the
		// stale ones (reaped / recorded / vanished) can be pruned below.
		const pendingUndated = new Set<string>();

		for (const sandbox of active) {
			if (recordedSandboxIds.has(sandbox.id)) continue; // owned by a record above

			// Rule 3 — a live sandbox with no record at all is an invisible orphan that
			// leaks billable compute forever. Reap it once past the grace window.
			let ageMs: number;
			if (sandbox.createdAt) {
				ageMs = now - new Date(sandbox.createdAt).getTime();
			} else {
				// The provider gave no creation timestamp, so we can't tell an in-flight
				// provision (record not yet visible) from a leaked orphan on a single
				// snapshot. Anchor the grace to a durable first-seen marker so it's left
				// alone at first sighting but still reaped a bounded time later — never
				// leaking forever, never reaped on sight.
				const firstSeen = await this.firstSeenOrphan(sandbox.id, now);
				pendingUndated.add(sandbox.id);
				ageMs = now - firstSeen;
			}
			if (ageMs < orphanGraceMs) continue;

			try {
				await this.compute.create(sandbox.id).destroy();
				orphansReaped++;
				orphanSandboxIds.push(sandbox.id);
				pendingUndated.delete(sandbox.id);
				await this.bucket.delete(paths.reconcileOrphan(sandbox.id)).catch(() => {});
			} catch {
				// Best-effort: a later sweep will retry.
			}
		}

		await this.pruneOrphanMarkers(pendingUndated);

		return {
			skipped: false,
			reclaimed,
			markedDead,
			orphansReaped,
			orphanSandboxIds,
			markedDeadSessions,
		};
	}

	/**
	 * First-seen epoch (ms) for a timestamp-less orphan: read the durable marker, or
	 * create it at `now` on first sighting. A marker that is absent, corrupt, or dated
	 * in the FUTURE (clock skew / tampering — which would otherwise defer reaping
	 * indefinitely) resets to `now`, so the worst case is one extra grace window —
	 * never an unbounded leak.
	 */
	private async firstSeenOrphan(sandboxId: SandboxId, now: number): Promise<number> {
		const key = paths.reconcileOrphan(sandboxId);
		const existing = await this.bucket.get(key);
		if (existing) {
			try {
				const { first_seen } = await readStored(OrphanMarkerSchema, existing, key);
				// A future timestamp is clock skew across writers, not corruption —
				// silently reset it to now (rewritten below) rather than logging an error.
				if (first_seen <= now) return first_seen;
			} catch (err) {
				logOperationalError(
					'corrupt_orphan_marker_replaced',
					{ operation: 'reconciliation.orphan_marker.read', object: key },
					err,
				);
			}
		}
		await this.bucket.put(key, JSON.stringify({ first_seen: now })).catch((err) => {
			logOperationalError(
				'orphan_marker_write_failed',
				{ operation: 'reconciliation.orphan_marker.write', object: key },
				err,
			);
		});
		return now;
	}

	/** Drop first-seen markers for orphans that are no longer pending (reaped, recorded, or gone). */
	private async pruneOrphanMarkers(keep: ReadonlySet<string>): Promise<void> {
		const keys = await listAllKeys(this.bucket, paths.reconcileOrphansPrefix).catch(() => []);
		const stale = keys.filter((k) => {
			const id = decodeURIComponent(
				k.slice(paths.reconcileOrphansPrefix.length).replace(/\.json$/, ''),
			);
			return !keep.has(id);
		});
		if (stale.length > 0) await this.bucket.delete(stale).catch(() => {});
	}
}
