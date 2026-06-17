import type { Bucket } from '../../ports/bucket';
import { Millis } from '../../duration';
import type { SandboxProvider } from '../../ports/sandbox';
import type { NotebookService } from '../content/NotebookService';
import { SandboxProvisioner } from './SandboxProvisioner';
import { isTerminal } from './sessionState';
import type { SessionService } from './SessionService';

/**
 * Default age below which a recordless sandbox is left alone. Provisioning
 * writes the session record BEFORE creating the sandbox, so a live sandbox
 * always has a record unless that record was already reaped — but this window
 * is a belt-and-suspenders guard against reaping an in-flight provision.
 */
const DEFAULT_ORPHAN_GRACE_MS = Millis.minutes(15);

export interface ReconcileResult {
	/** True when the provider can't enumerate (no `listActive`) — nothing reconciled. */
	skipped: boolean;
	/** Rule 1: terminal records whose still-running sandbox was torn down. */
	reclaimed: number;
	/** Rule 2: live records whose sandbox had vanished, now marked terminated. */
	markedDead: number;
	/** Rule 3: live sandboxes with no record at all, destroyed. */
	orphansReaped: number;
	/** Ids of the orphan sandboxes destroyed by Rule 3 — surfaced for audit logging. */
	orphanSandboxIds: string[];
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
	private readonly provisioner: SandboxProvisioner;

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
		this.provisioner = new SandboxProvisioner(compute);
	}

	async reconcile(opts?: { orphanGraceMs?: number }): Promise<ReconcileResult> {
		// No provider truth to reconcile against — leave the bucket sweep to do its
		// record-only job and report a clean no-op.
		if (!this.compute.listActive) {
			return { skipped: true, reclaimed: 0, markedDead: 0, orphansReaped: 0, orphanSandboxIds: [] };
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

		let reclaimed = 0;
		let markedDead = 0;
		let orphansReaped = 0;
		const orphanSandboxIds: string[] = [];

		for (const session of sessions) {
			const sandboxId = session.sandbox_id;
			if (!sandboxId) continue;

			const terminal = isTerminal(session.status);
			const isLive = session.status === 'running' || session.status === 'starting';

			if (terminal && activeIds.has(sandboxId)) {
				// Rule 1 — terminal record, sandbox still alive (and billing). Save edits
				// back when reachable, then guarantee the sandbox dies.
				const sandbox = this.compute.create(sandboxId);
				try {
					await this.provisioner.teardown(
						sandbox,
						this.notebooks,
						this.bucket,
						session.project_id,
						session.notebook_id,
						session.user_id,
						this.persistWorkspace,
						this.workdir,
						{ persistEdits: !session.ephemeral },
					);
				} catch {
					try {
						await sandbox.destroy();
					} catch {
						// Best-effort: a later sweep will retry if the sandbox survives.
					}
				}
				reclaimed++;
			} else if (isLive && !activeIds.has(sandboxId)) {
				// Rule 2 — live record, sandbox gone (crashed / idle-timed-out). The
				// kernel URL is dead; mark the record failed (it didn't stop cleanly) so it
				// stops being served and gets reaped on schedule.
				try {
					await this.sessions.markFailed(session.project_id, session.session_id);
					markedDead++;
				} catch {
					// Best-effort: the session may have been deleted concurrently.
				}
			}
		}

		for (const sandbox of active) {
			if (recordedSandboxIds.has(sandbox.id)) continue; // owned by a record above

			// Rule 3 — a live sandbox with no record at all is an invisible orphan that
			// leaks billable compute forever. Reap it once past the grace window.
			if (sandbox.createdAt) {
				const ageMs = now - new Date(sandbox.createdAt).getTime();
				if (ageMs < orphanGraceMs) continue;
			}

			try {
				await this.compute.create(sandbox.id).destroy();
				orphansReaped++;
				orphanSandboxIds.push(sandbox.id);
			} catch {
				// Best-effort: a later sweep will retry.
			}
		}

		return { skipped: false, reclaimed, markedDead, orphansReaped, orphanSandboxIds };
	}
}
