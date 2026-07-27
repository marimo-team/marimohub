import type { Bucket } from '../../ports/bucket';
import { MARIMO_PORT } from '../../constants';
import { mapWithConcurrency } from '../../concurrency';
import { Millis } from '../../duration';
import type { NotebookId } from '../../ids';
import type { SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import type { Session } from '../../schema';
import type { NotebookService } from '../content/NotebookService';
import { SandboxProvisioner } from './SandboxProvisioner';
import { SessionRetirer } from './SessionRetirer';
import { isTerminal, sessionModePolicy, sessionPersistsEdits } from './sessionState';
import type { SessionService } from './SessionService';

const SESSION_SWEEP_CONCURRENCY = 8;

/**
 * How long after `started_at` an `expired` record's sandbox is left alone.
 * A slow provision (cold image, large workspace copy) can outlive the 5-minute
 * heartbeat TTL and be flipped to `expired` while still restoring files; tearing
 * it down mid-restore would mirror-delete not-yet-restored workspace keys from
 * the bucket. Mirrors the reconciler's orphan grace window.
 */
const RECLAIM_PROVISION_GRACE_MS = Millis.minutes(15);

/**
 * Ask the marimo kernel how many websocket connections (editors) it has, via an
 * `exec` INSIDE the sandbox — exposure-mode-independent (works for `subdomain`
 * and `proxy`) and needs no auth (the kernel runs with `--no-token`).
 *
 * `basePath` is the prefix marimo serves under (its `--base-url`, e.g.
 * `/proxy/<token>` in proxy exposure) — the status endpoint exists ONLY under
 * that prefix, so probing the root there would always 404 into a null.
 *
 * Returns null when the kernel could not be reached or answered garbage —
 * "unknown", which callers treat conservatively: a session with a fresh
 * heartbeat is never reaped on a null probe; only stale AND unreachable
 * (⇒ the kernel is almost certainly dead) is reaped.
 */
export async function kernelActiveConnections(
	sandbox: SandboxInstance,
	basePath = '',
): Promise<number | null> {
	try {
		const res = await sandbox.exec(
			`python3 -c "import json,urllib.request;` +
				`print(json.load(urllib.request.urlopen('http://127.0.0.1:${MARIMO_PORT}${basePath}/api/status/connections',timeout=3))['active'])"`,
		);
		if (!res.success) return null;
		// Whole output or nothing — `parseInt` would read 2 out of "2garbage", and a
		// half-parsed answer must count as unknown rather than steer reaping.
		const out = res.stdout.trim();
		return /^\d+$/.test(out) ? Number(out) : null;
	} catch {
		return null;
	}
}

/** Injectable probe seam (tests fake the kernel answer without an exec fake). */
export type ConnectionProbe = (
	sandbox: SandboxInstance,
	basePath?: string,
) => Promise<number | null>;

/**
 * The kernel's serving prefix, recovered from the session's client URL:
 * `/proxy/<token>` under proxy exposure (where the URL's path IS marimo's
 * `--base-url`), empty under subdomain exposure (kernel at root).
 */
function kernelBasePath(s: Session): string {
	if (!s.sandbox_url) return '';
	try {
		return new URL(s.sandbox_url).pathname.replace(/\/$/, '');
	} catch {
		return '';
	}
}

export interface SessionLifecycleConfig {
	/** Reap (with save) when there are no active connections AND the heartbeat is this stale. */
	idleTimeoutMs: number;
	/** Periodic save cadence for live sessions; 0 disables snapshots. */
	snapshotIntervalMs: number;
	/** How far `expires_at` slides when editors are still connected at the deadline. */
	extensionMs: number;
	/** Consult the kernel before a lifetime/idle teardown; off = reap on schedule. */
	connectionAware: boolean;
	persistWorkspace: 'source' | 'workspace';
	workdir?: string;
}

export interface SweepResult {
	/** Sessions saved by the periodic snapshot floor. */
	snapshotted: number;
	/** Deadlines slid forward because editors were still connected. */
	extended: number;
	/** Live sessions reaped at their `expires_at` deadline. */
	reapedExpired: number;
	/** Live sessions reaped as idle (no editors + stale heartbeat). */
	reapedIdle: number;
	/** Terminal records whose lingering sandbox was destroyed (saved first for `expired`). */
	reclaimed: number;
}

/**
 * Record-driven session lifecycle sweep: graceful lifetime teardown, idle
 * reaping, connection-aware deadline extension, and the periodic snapshot floor.
 *
 * Unlike `ReconciliationService` this needs no provider enumeration
 * (`listActive`) — it drives entirely off session records, so it works on
 * backends that cannot map provider sandboxes back to sessions (CoreWeave).
 * There, the provider's own `maxLifetimeSeconds` is only a hard backstop
 * (2× the session TTL) against sandboxes this sweep can no longer see.
 */
export class SessionLifecycleService {
	private readonly provisioner: SandboxProvisioner;
	private readonly retirer: SessionRetirer;

	constructor(
		private sessions: SessionService,
		private notebooks: NotebookService,
		private compute: SandboxProvider,
		private bucket: Bucket,
		private cfg: SessionLifecycleConfig,
		private probe: ConnectionProbe = kernelActiveConnections,
	) {
		this.provisioner = new SandboxProvisioner(compute);
		this.retirer = new SessionRetirer({
			sessions,
			notebooks,
			compute,
			bucket,
			persistWorkspace: cfg.persistWorkspace,
			workdir: cfg.workdir,
		});
	}

	async sweep(now = Date.now()): Promise<SweepResult> {
		const sessions = await this.sessions.listSessions();
		// Candidates: `running` sessions, plus any terminal record still holding a
		// sandbox_id that has not been confirmed destroyed. The `expired` ones are
		// the stale-heartbeat reaper's leak (record flipped, sandbox never touched);
		// `terminated`/`failed` normally had their sandbox destroyed already, so
		// their reclaim is a one-time idempotent confirm-destroy that catches a
		// teardown whose destroy silently failed. `starting` is excluded on purpose:
		// its provision is in flight (a snapshot mid-restore could mirror-delete
		// not-yet-restored workspace files); a wedged provision reaches this sweep
		// once the stale reaper flips it to `expired`.
		const candidates = sessions.filter(
			(s) =>
				s.sandbox_id &&
				(s.status === 'running' || (isTerminal(s.status) && !s.sandbox_reclaimed_at)),
		);
		// Notebooks that currently have a live PERSISTING session. An older (expired)
		// sandbox for one of these must never commit: its content is stale by
		// definition and would clobber the live session's head version. App sessions
		// never write back, so they must not count — a long-lived shared app must
		// not suppress the save of an expired edit session on its notebook.
		const liveNotebooks = new Set<NotebookId>(
			sessions
				.filter(
					(s) => (s.status === 'running' || s.status === 'starting') && sessionPersistsEdits(s),
				)
				.map((s) => s.notebook_id),
		);

		const result: SweepResult = {
			snapshotted: 0,
			extended: 0,
			reapedExpired: 0,
			reapedIdle: 0,
			reclaimed: 0,
		};

		await mapWithConcurrency(candidates, SESSION_SWEEP_CONCURRENCY, async (s) => {
			const sandbox = this.compute.create(s.sandbox_id!);

			const heartbeatStale = now - Date.parse(s.last_heartbeat) > this.cfg.idleTimeoutMs;
			const pastDeadline = !!s.expires_at && now >= Date.parse(s.expires_at);

			// Only probe when a reap decision hinges on it (cost control: one exec per
			// near-deadline/stale session per sweep, nothing for healthy ones). Only an
			// `expired` record can still have a live kernel among the terminal ones.
			// Exception: every running app session is probed each sweep — its
			// connection count feeds the "~N connected" stop-confirm hint.
			let active: number | null = null;
			const reapCandidate =
				s.status === 'expired' || (s.status === 'running' && (pastDeadline || heartbeatStale));
			const appConnectionCheck = sessionModePolicy(s).singleton && s.status === 'running';
			if (this.cfg.connectionAware && (reapCandidate || appConnectionCheck)) {
				active = await this.probe(sandbox, kernelBasePath(s));
				// A null probe is "unknown" — leave the last stamp rather than write a
				// lie. An unchanged count is skipped too: no CAS/ETag churn against
				// heartbeats for the steady state.
				if (appConnectionCheck && active !== null && active !== s.active_connections) {
					await this.sessions
						.markConnections(s.project_id, s.session_id, active, new Date(now).toISOString())
						.catch(() => {});
				}
			}
			const hasEditors = (active ?? 0) > 0;

			if (isTerminal(s.status)) {
				const superseded = liveNotebooks.has(s.notebook_id);
				if (s.status === 'expired' && hasEditors) {
					// Editors can still be connected to an `expired` record's kernel —
					// heartbeats travel browser→API while the websocket goes browser→kernel
					// directly, so an API-path outage or a throttled background tab stalls
					// heartbeats without ending the session. Keep the kernel alive for them
					// (the snapshot below bounds loss) and reclaim once they disconnect —
					// but never snapshot once a newer live session owns the notebook.
					if (superseded) return;
				} else {
					// A provision that outlived the heartbeat TTL can be flipped `expired`
					// while still restoring files — leave it alone until safely past the
					// provision window (a teardown mid-restore mirror-deletes bucket keys).
					if (
						s.status === 'expired' &&
						now - Date.parse(s.started_at) < RECLAIM_PROVISION_GRACE_MS
					) {
						return;
					}
					const save = s.status === 'expired' && !superseded && sessionPersistsEdits(s);
					// Only `expired` reclaims are counted: for terminated/failed records the
					// confirm-destroy is a routine no-op, not a recovered leak.
					if ((await this.retirer.reclaim(s, save)) && s.status === 'expired') {
						result.reclaimed++;
					}
					return;
				}
			} else {
				// A null probe is "unknown", not "no editors": with a fresh heartbeat,
				// extend at the deadline rather than killing a possibly-live editor on a
				// probe hiccup. Idle reaping already requires the stale heartbeat as
				// corroboration that the kernel is really gone.
				const mayHaveEditors =
					hasEditors || (this.cfg.connectionAware && active === null && !heartbeatStale);

				if (heartbeatStale && !hasEditors) {
					if (await this.gracefulTeardown(s)) result.reapedIdle++;
					return;
				}
				if (pastDeadline) {
					if (mayHaveEditors) {
						// Slide the deadline; the user keeps editing. Falls through to the
						// snapshot so long-lived sessions still hit the durability floor.
						await this.sessions
							.extendExpiry(
								s.project_id,
								s.session_id,
								new Date(now + this.cfg.extensionMs).toISOString(),
							)
							.catch(() => {});
						result.extended++;
					} else {
						if (await this.gracefulTeardown(s)) result.reapedExpired++;
						return;
					}
				}
			}

			// Periodic snapshot floor: even a residual hard kill (the provider
			// backstop, node loss, OOM) loses at most one interval of notebook edits.
			// Source-only (`includeWorkspace: false`): a full workspace mirror every
			// interval is too expensive; the mirror still refreshes at teardown.
			const snapshotDue =
				sessionPersistsEdits(s) &&
				this.cfg.snapshotIntervalMs > 0 &&
				now - Date.parse(s.last_snapshot_at ?? s.started_at) >= this.cfg.snapshotIntervalMs;
			if (snapshotDue) {
				const saved = await this.provisioner
					.captureSession(
						sandbox,
						this.notebooks,
						this.bucket,
						s.project_id,
						s.notebook_id,
						s.user_id,
						this.cfg.persistWorkspace,
						this.cfg.workdir,
						{ includeWorkspace: false },
					)
					.catch(() => null); // failed save: retry next sweep
				if (saved !== null) {
					// Also advances for remote sources (saved === false, nothing to
					// persist), so they are re-checked per interval, not per sweep.
					await this.sessions
						.markSnapshotted(s.project_id, s.session_id, new Date(now).toISOString())
						.catch(() => {});
					if (saved) result.snapshotted++;
				}
			}
		});

		return result;
	}

	/**
	 * Reap one LIVE session: CAS-claim via `beginTerminating` (an explicit stop or
	 * concurrent sweep wins the race and this no-ops), then retire through the
	 * one seam (save + destroy + terminal mark + claim release). If the destroy
	 * inside teardown silently failed, the terminal record re-enters the sweep
	 * as a reclaim candidate, so nothing is leaked.
	 */
	private async gracefulTeardown(s: Session): Promise<boolean> {
		const claimed = await this.sessions
			.beginTerminating(s.project_id, s.session_id)
			.catch(() => null);
		if (!claimed?.transitioned) return false;
		await this.retirer.retire(s);
		return true;
	}
}
