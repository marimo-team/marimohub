import type { Bucket, BucketObject } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import type { SessionMode } from '../../constants';
import { mapWithConcurrency } from '../../concurrency';
import { Millis } from '../../duration';
import { NotFoundError, PreconditionFailedError } from '../../errors';
import { acquireSingletonClaim, mutateObject, releaseSingletonClaim } from '../catalog/cas';
import type { SingletonClaimConfig } from '../catalog/cas';
import { createSessionId } from '../../ids';
import type { NotebookId, ProjectId, SandboxId, SessionId, UserId, VersionId } from '../../ids';
import { paths } from '../../paths';
import { AppClaimSchema, parseStored, SessionSchema } from '../../schema';
import type { Session } from '../../schema';
import {
	ACTIVE_STATUSES,
	isTerminal,
	nextStatus,
	PRESENT_STATUSES,
	MODE_POLICY,
	sessionMode,
	sessionModePolicy,
} from './sessionState';
import { listAllObjects } from '../catalog/storage';

export interface CreateSessionInput {
	notebook_id: NotebookId;
	project_id: ProjectId;
	user_id: UserId;
	runtime?: { python_version?: string; marimo_version?: string };
	sandbox_id?: SandboxId;
	sandbox_url?: string;
	compute_profile?: string;
	/** Viewer session whose edits are discarded at teardown (see SessionSchema). */
	ephemeral?: boolean;
	/** `edit` (default) or `app` (the shared singleton; see SessionSchema). */
	mode?: SessionMode;
	/** `app` only: the notebook's head version at provision, for staleness detection. */
	source_version_id?: VersionId;
}

const HEARTBEAT_TTL_MS = Millis.minutes(5);
const TERMINAL_RETENTION_MS = Millis.hours(24);
// Coalesce heartbeat persistence: an already-running session is only re-written
// once its stored heartbeat is older than this. Bounds heartbeat writes to
// ~1/interval/session regardless of client cadence, while staying well within
// HEARTBEAT_TTL_MS so a live session is never spuriously expired.
const HEARTBEAT_PERSIST_INTERVAL_MS = Millis.seconds(60);

/** Sentinel for a session object that vanished between list and read. */
const SKIP = Symbol('missing-session');

/**
 * Total order over session records — every replica derives the same queue
 * position from the same records, which is what lets the create route's cap
 * recheck pick one winner instead of every racer rejecting the others.
 */
const byStartOrder = (a: Session, b: Session) =>
	a.started_at.localeCompare(b.started_at) || a.session_id.localeCompare(b.session_id);

export class SessionService {
	constructor(
		private bucket: Bucket,
		private metrics: Metrics = noopMetrics,
	) {}

	/**
	 * Compare-and-swap a session record so every status transition is atomic: a
	 * `terminate` that commits can't be clobbered back to `running` by an in-flight
	 * heartbeat — its conditional write fails the ETag check, `apply` re-runs against
	 * the fresh (terminal) state, and no-ops. See `mutateObject` in `./cas`.
	 */
	private mutate(
		projectId: ProjectId,
		id: SessionId,
		apply: (session: Session) => Session | null,
	): Promise<Session> {
		return mutateObject(
			this.bucket,
			paths.session(projectId, id),
			(raw) => SessionSchema.parse(raw),
			apply,
			{
				notFound: () => new NotFoundError(`Session ${id} not found`),
				onConflict: () => this.metrics.increment('sessions.cas.conflict'),
				onExhausted: () => this.metrics.increment('sessions.cas.exhausted'),
			},
		);
	}

	async createSession(input: CreateSessionInput): Promise<Session> {
		const sessionId = createSessionId();
		const now = new Date().toISOString();

		const session: Session = {
			session_id: sessionId,
			notebook_id: input.notebook_id,
			project_id: input.project_id,
			user_id: input.user_id,
			status: 'starting',
			started_at: now,
			last_heartbeat: now,
			...(input.ephemeral ? { ephemeral: true } : {}),
			...(input.mode && input.mode !== 'edit' ? { mode: input.mode } : {}),
			...(input.source_version_id ? { source_version_id: input.source_version_id } : {}),
			runtime: input.runtime,
			sandbox_id: input.sandbox_id,
			sandbox_url: input.sandbox_url,
			compute_profile: input.compute_profile,
		};

		await this.bucket.put(paths.session(input.project_id, sessionId), JSON.stringify(session));
		return session;
	}

	async getSession(projectId: ProjectId, id: SessionId): Promise<Session> {
		const key = paths.session(projectId, id);
		const obj = await this.bucket.get(key);
		if (!obj) {
			throw new NotFoundError(`Session ${id} not found`);
		}

		return parseStored(SessionSchema, await obj.json(), key);
	}

	/** Promote `starting` → `running` with the kernel URL. No-op if the session was
	 * terminated/terminating/failed/expired while we were provisioning (a stop wins). */
	async setRunning(
		projectId: ProjectId,
		id: SessionId,
		sandboxUrl: string,
		usedFallback?: boolean,
		originUrl?: string,
		expiresAt?: string,
	): Promise<Session> {
		return this.mutate(projectId, id, (session) => {
			if (isTerminal(session.status) || session.status === 'terminating') return null;
			return {
				...session,
				status: 'running',
				sandbox_url: sandboxUrl,
				// Persisted only in `proxy` exposure mode (the forwarder's target); absent
				// in `subdomain` mode where the client reaches the kernel directly.
				sandbox_origin_url: originUrl,
				used_fallback: usedFallback,
				...(expiresAt ? { expires_at: expiresAt } : {}),
			};
		});
	}

	/** Slide a live session's graceful-teardown deadline forward (the lifecycle
	 * sweep extends instead of reaping while editors are still connected). Never
	 * revives a terminal/terminating session. */
	async extendExpiry(projectId: ProjectId, id: SessionId, newExpiresAt: string): Promise<Session> {
		return this.mutate(projectId, id, (session) => {
			if (isTerminal(session.status) || session.status === 'terminating') return null;
			return { ...session, expires_at: newExpiresAt };
		});
	}

	/** Record when the periodic snapshotter last saved this session. Pure cadence
	 * bookkeeping — never touches status, so it also applies to an `expired` record
	 * whose sandbox is still being snapshotted while editors remain connected. */
	async markSnapshotted(projectId: ProjectId, id: SessionId, at: string): Promise<Session> {
		return this.mutate(projectId, id, (session) => ({ ...session, last_snapshot_at: at }));
	}

	/** Record that the lifecycle sweep saved + destroyed the sandbox of an
	 * already-terminal record, so reclaim is attempted exactly once. */
	async markSandboxReclaimed(projectId: ProjectId, id: SessionId, at: string): Promise<Session> {
		return this.mutate(projectId, id, (session) => ({ ...session, sandbox_reclaimed_at: at }));
	}

	/** Refresh a live session's heartbeat (keeps it off the TTL reaper). Coalesced
	 * to ~1 write/60s; never revives a terminal/terminating session. */
	async heartbeat(projectId: ProjectId, id: SessionId): Promise<Session> {
		return this.mutate(projectId, id, (session) => {
			if (isTerminal(session.status) || session.status === 'terminating') return null;
			const ageMs = Date.now() - new Date(session.last_heartbeat).getTime();
			if (session.status === 'running' && ageMs < HEARTBEAT_PERSIST_INTERVAL_MS) return null;
			return { ...session, status: 'running', last_heartbeat: new Date().toISOString() };
		});
	}

	/**
	 * Mark a session `terminating` (stop requested; teardown in flight). Visible to
	 * pollers as `Stopping…`. No-op on a session that is already
	 * terminal/terminating — `transitioned` reports whether THIS call won the
	 * transition, so exactly one racer owns the teardown (a loser must not run a
	 * second save-and-destroy over the same sandbox).
	 */
	async beginTerminating(
		projectId: ProjectId,
		id: SessionId,
	): Promise<{ session: Session; transitioned: boolean }> {
		let transitioned = false;
		const session = await this.mutate(projectId, id, (current) => {
			const next = nextStatus(current.status, 'terminate');
			transitioned = next !== null;
			return next ? { ...current, status: next } : null;
		});
		return { session, transitioned };
	}

	/** Mark a session `terminated` (teardown finished). Terminates from any live or
	 * `terminating` state; no-op once terminal. */
	async markTerminated(projectId: ProjectId, id: SessionId): Promise<Session> {
		return this.mutate(projectId, id, (session) =>
			isTerminal(session.status) ? null : { ...session, status: 'terminated' },
		);
	}

	/** Convenience: take a session straight to `terminated` (no visible
	 * `terminating` step). For an interactive stop prefer `beginTerminating` then
	 * `markTerminated` so pollers see `Stopping…` during teardown. */
	async terminate(projectId: ProjectId, id: SessionId): Promise<Session> {
		return this.markTerminated(projectId, id);
	}

	/** Mark a session `failed` (provision/runtime error), optionally recording a
	 * sanitized reason for the client. No-op once terminal or already `terminating`
	 * (an explicit stop is not downgraded to a failure). */
	async markFailed(
		projectId: ProjectId,
		id: SessionId,
		error?: { code: string; message: string },
	): Promise<Session> {
		return this.mutate(projectId, id, (session) =>
			isTerminal(session.status) || session.status === 'terminating'
				? null
				: { ...session, status: 'failed', ...(error ? { error } : {}) },
		);
	}

	/**
	 * List + read every session record under the sessions prefix, handing each to
	 * `handle` in bounded-parallel (records that vanished between list and read are
	 * skipped). `etag` is the freshly-read ETag, for a caller doing a conditional
	 * write within the same pass. Backs every session scan — the request path
	 * (listActiveByProject on each notebook-table render, findReusable/
	 * countActiveForUser on create) and the reaper passes.
	 */
	private async scanSessions<T>(
		handle: (session: Session, obj: BucketObject, etag: string) => T | Promise<T>,
	): Promise<Awaited<T>[]> {
		return this.scanPrefix(paths.sessionsPrefix, handle);
	}

	/**
	 * Scope a scan to a single project's prefix (`_system/sessions/{pid}/`) — the
	 * partition introduced so the interactive reads (`listActiveByProject`,
	 * `findReusable`) cost O(that project's sessions), not O(all sessions).
	 */
	private async scanProject<T>(
		projectId: ProjectId,
		handle: (session: Session, obj: BucketObject, etag: string) => T | Promise<T>,
	): Promise<Awaited<T>[]> {
		return this.scanPrefix(paths.sessionsForProject(projectId), handle);
	}

	private async scanPrefix<T>(
		prefix: string,
		handle: (session: Session, obj: BucketObject, etag: string) => T | Promise<T>,
	): Promise<Awaited<T>[]> {
		const objects = await listAllObjects(this.bucket, prefix);
		const scanned = await mapWithConcurrency(objects, BUCKET_SCAN_CONCURRENCY, async (obj) => {
			const body = await this.bucket.get(obj.key);
			if (!body) return SKIP;
			// A single corrupt/legacy record must not abort a deployment-wide scan
			// (listing, reuse, reaper). Skip it (logged) so the good records survive.
			let session: Session;
			try {
				session = SessionSchema.parse(await body.json());
			} catch (err) {
				console.warn(`scanPrefix: skipping unreadable session ${obj.key}: ${String(err)}`);
				return SKIP;
			}
			return handle(session, obj, body.etag);
		});
		return scanned.filter((r): r is Awaited<T> => r !== SKIP);
	}

	async listSessions(notebookId?: NotebookId): Promise<Session[]> {
		const sessions = await this.scanSessions((session) => session);
		return notebookId ? sessions.filter((s) => s.notebook_id === notebookId) : sessions;
	}

	/**
	 * List a project's present sessions (`starting`/`running`/`terminating`) —
	 * terminal sessions are excluded. Powers the per-notebook runtime-status
	 * indicators in the notebook table (`terminating` renders as `Stopping…`).
	 *
	 * Scoped to the project's own prefix (`_system/sessions/{pid}/`), so
	 * cost is O(this project's sessions), not O(all sessions deployment-wide).
	 */
	async listActiveByProject(projectId: ProjectId): Promise<Session[]> {
		const present = PRESENT_STATUSES as readonly Session['status'][];
		const sessions = await this.scanProject(projectId, (session) => session);
		return sessions.filter((s) => present.includes(s.status));
	}

	/**
	 * Find a session the caller can REUSE for this notebook so a refresh during
	 * start doesn't pile up sandboxes: a `running` session with a `sandbox_url`
	 * (reconnect to the live kernel), OR an in-flight `starting` session still
	 * within the provision window (attach to the one already provisioning — the
	 * client polls it to `running`). Stale `starting` records are ignored so a
	 * wedged provision isn't reused forever. Returns the most recently
	 * heartbeated match.
	 *
	 * Reuse is keyed per the mode's `reuseScope`: `per-user` (edit) matches only
	 * the caller's own session; `per-notebook` (the shared app) is user-blind —
	 * ANY editor's request attaches. That user-blind reuse IS the singleton, so
	 * for a singleton mode the CLAIM, not the heartbeat order, decides which
	 * candidate is handed out.
	 */
	async findReusable(
		projectId: ProjectId,
		notebookId: NotebookId,
		userId: UserId,
		mode: SessionMode = 'edit',
	): Promise<Session | undefined> {
		const now = Date.now();
		const policy = MODE_POLICY[mode];
		const userBlind = policy.reuseScope === 'per-notebook';
		// Scoped to the project prefix; filter to the notebook in memory.
		const sessions = await this.scanProject(projectId, (session) => session);
		const candidates = sessions.filter(
			(s) =>
				s.notebook_id === notebookId &&
				sessionMode(s) === mode &&
				(userBlind || s.user_id === userId) &&
				((s.status === 'running' && !!s.sandbox_url) ||
					(s.status === 'starting' && now - new Date(s.started_at).getTime() < HEARTBEAT_TTL_MS)),
		);
		if (policy.singleton) return this.claimHolderAmong(projectId, notebookId, candidates);
		return candidates.sort(
			(a, b) => new Date(b.last_heartbeat).getTime() - new Date(a.last_heartbeat).getTime(),
		)[0];
	}

	/**
	 * The candidate that currently HOLDS the app claim. Heartbeat order is not
	 * authority here: two racers can both be `starting`, and the one that lost
	 * `claimApp` tears its own record down — handing it out as the shared app
	 * strands the attaching caller on a session that will never run. An absent,
	 * free, corrupt, or dangling claim means no live holder, so the caller
	 * correctly starts fresh and steals the stale claim via `acquireSingletonClaim`.
	 */
	private async claimHolderAmong(
		projectId: ProjectId,
		notebookId: NotebookId,
		candidates: Session[],
	): Promise<Session | undefined> {
		const obj = await this.bucket.get(paths.appClaim(projectId, notebookId));
		if (!obj) return undefined;
		let holder: SessionId | null;
		try {
			holder = AppClaimSchema.parse(await obj.json()).session_id;
		} catch {
			return undefined;
		}
		return holder ? candidates.find((s) => s.session_id === holder) : undefined;
	}

	/**
	 * Count a user's active sessions (`starting`/`running`) — `terminating` is
	 * excluded so a stop immediately frees a slot. The create-session route uses
	 * this to enforce a concurrent-session cap (a cost-DoS guard against a runaway
	 * client) — as a pre-flight only, since count→create is not atomic; the route
	 * re-ranks via `listActiveForUser` once the record exists. The per-notebook
	 * reuse in `findReusable` is what stops a refresh loop from tripping it.
	 */
	async countActiveForUser(userId: UserId, capScope: 'user' | 'project' = 'user'): Promise<number> {
		return (await this.listActiveForUser(userId, capScope)).length;
	}

	/**
	 * The sessions `countActiveForUser` counts, in start order — the cap recheck
	 * needs WHERE in the queue a session landed, not just how many there are.
	 *
	 * Scoped per cap: `user` = the caller's edit slots; `project` = the apps this
	 * user STARTED, deployment-wide — the per-user cost bound that stops fanning
	 * apps out across projects from creating unbounded sandboxes.
	 */
	async listActiveForUser(
		userId: UserId,
		capScope: 'user' | 'project' = 'user',
	): Promise<Session[]> {
		const active = ACTIVE_STATUSES as readonly Session['status'][];
		const sessions = await this.listSessions();
		return sessions
			.filter(
				(s) =>
					s.user_id === userId &&
					active.includes(s.status) &&
					sessionModePolicy(s).capScope === capScope,
			)
			.sort(byStartOrder);
	}

	/**
	 * Count a project's active app sessions, for the per-project app cap
	 * (`MARIMOHUB_MAX_APPS_PER_PROJECT`). Pre-flight only, like
	 * `countActiveForUser`; the user-blind reuse in `findReusable` keeps an
	 * attach from ever tripping it. `terminating` is excluded (matching the
	 * user cap): a stop frees the slot while teardown finishes, so the live
	 * sandbox count can briefly exceed the cap.
	 */
	async countActiveAppsForProject(projectId: ProjectId): Promise<number> {
		return (await this.listActiveAppsForProject(projectId)).length;
	}

	/** The sessions `countActiveAppsForProject` counts, in start order. */
	async listActiveAppsForProject(projectId: ProjectId): Promise<Session[]> {
		const active = ACTIVE_STATUSES as readonly Session['status'][];
		const sessions = await this.scanProject(projectId, (session) => session);
		return sessions
			.filter((s) => active.includes(s.status) && sessionModePolicy(s).capScope === 'project')
			.sort(byStartOrder);
	}

	/**
	 * Stamp the lifecycle sweep's kernel connection-count probe onto an app
	 * session, so stop/restart confirmations can show "~N connected". Pure
	 * bookkeeping — never touches status.
	 */
	async markConnections(
		projectId: ProjectId,
		id: SessionId,
		activeConnections: number,
		at: string,
	): Promise<Session> {
		return this.mutate(projectId, id, (session) => ({
			...session,
			active_connections: activeConnections,
			connections_checked_at: at,
		}));
	}

	/** The app-singleton lease over `_system/apps/{pid}/{nid}.json` (see AppClaimSchema). */
	private appClaimConfig(projectId: ProjectId, notebookId: NotebookId): SingletonClaimConfig {
		return {
			bucket: this.bucket,
			key: paths.appClaim(projectId, notebookId),
			serialize: (holder) =>
				JSON.stringify({ session_id: holder, claimed_at: new Date().toISOString() }),
			parseHolder: (raw) => AppClaimSchema.parse(raw).session_id,
			isHolderLive: (holder) => this.holdsLiveApp(projectId, notebookId, holder as SessionId),
			onReleaseError: (err) => {
				this.metrics.increment('sessions.app_claim.release_error');
				console.warn(`releaseApp: app claim for notebook ${notebookId}: ${String(err)}`);
			},
			retry: {
				onConflict: () => this.metrics.increment('sessions.app_claim.conflict'),
				onExhausted: () => this.metrics.increment('sessions.app_claim.exhausted'),
			},
		};
	}

	/**
	 * Claim the per-notebook app singleton for `sessionId`. Exactly one of N
	 * concurrent "Run as app" sagas wins; a loser gets `{ claimed: false,
	 * holder }` and attaches to the winner via the user-blind reuse path. A
	 * claim whose holder is terminal, absent, or a wedged `starting` record
	 * past the provision window is stale and replaced. Idempotent for the
	 * current holder. (Semantics live in `acquireSingletonClaim`.)
	 */
	async claimApp(
		projectId: ProjectId,
		notebookId: NotebookId,
		sessionId: SessionId,
	): Promise<{ claimed: boolean; holder: SessionId }> {
		const { acquired, holder } = await acquireSingletonClaim(
			this.appClaimConfig(projectId, notebookId),
			sessionId,
		);
		return { claimed: acquired, holder: holder as SessionId };
	}

	/**
	 * Whether `holder` still owns THIS notebook's app: a singleton-mode session on
	 * `notebookId` that is `running`, or `starting` and fresh. Referential
	 * integrity counts as liveness — a claim naming an edit session or another
	 * notebook's app is invalid, and treating it as live would leave the notebook
	 * permanently unable to run as an app.
	 */
	private async holdsLiveApp(
		projectId: ProjectId,
		notebookId: NotebookId,
		holder: SessionId,
	): Promise<boolean> {
		try {
			const session = await this.getSession(projectId, holder);
			if (session.notebook_id !== notebookId || !sessionModePolicy(session).singleton) {
				return false;
			}
			return (
				session.status === 'running' ||
				(session.status === 'starting' &&
					Date.now() - new Date(session.started_at).getTime() < HEARTBEAT_TTL_MS)
			);
		} catch (err) {
			if (err instanceof NotFoundError) return false;
			throw err;
		}
	}

	/**
	 * Release the app claim held by `sessionId` — a no-op when someone else holds
	 * it, including one who re-acquired mid-release (the CAS in
	 * `releaseSingletonClaim` loses rather than clobbering them). The object stays,
	 * marked free; `deleteNotebook`/`deleteProject` remove it.
	 */
	async releaseApp(
		projectId: ProjectId,
		notebookId: NotebookId,
		sessionId: SessionId,
	): Promise<void> {
		await releaseSingletonClaim(this.appClaimConfig(projectId, notebookId), sessionId);
	}

	/**
	 * Release the claim a just-retired session may hold — a no-op for
	 * non-singleton modes, so every teardown path can call it unconditionally.
	 */
	async releaseAppFor(
		session: Pick<Session, 'mode' | 'project_id' | 'notebook_id' | 'session_id'>,
	): Promise<void> {
		if (!sessionModePolicy(session).singleton) return;
		await this.releaseApp(session.project_id, session.notebook_id, session.session_id);
	}

	async expireStale(): Promise<number> {
		const now = Date.now();

		// Scan + expire in bounded-parallel: reads and the per-session conditional
		// PUTs are independent (each keyed by its own ETag), so the reaper pass no
		// longer scales linearly with the session count.
		const results = await this.scanSessions(async (session, obj, etag) => {
			if (isTerminal(session.status)) return { expired: 0, live: 0 };

			const stale = now - new Date(session.last_heartbeat).getTime() > HEARTBEAT_TTL_MS;
			if (!stale) {
				const isLive = session.status === 'starting' || session.status === 'running';
				return { expired: 0, live: isLive ? 1 : 0 };
			}

			// starting/running → expired; a `terminating` session whose teardown hung
			// past the TTL is forced to terminated. Conditional on the scanned ETag so a
			// concurrent transition wins (the next pass re-checks); no retry loop here.
			const target = nextStatus(session.status, 'expire');
			if (!target) return { expired: 0, live: 0 };
			try {
				await this.bucket.put(obj.key, JSON.stringify({ ...session, status: target }), {
					onlyIfEtagMatches: etag,
				});
				return { expired: 1, live: 0 };
			} catch (err) {
				if (!(err instanceof PreconditionFailedError)) throw err;
				return { expired: 0, live: 0 };
			}
		});

		const expired = results.reduce((sum, r) => sum + r.expired, 0);
		const live = results.reduce((sum, r) => sum + r.live, 0);

		// `live` is the live-sandbox/session count an operator can't otherwise
		// infer; cost should be derived from the compute provider (see operations.md).
		this.metrics.gauge('sessions.live', live);
		if (expired > 0) this.metrics.increment('sessions.expired', expired);

		return expired;
	}

	/**
	 * Delete terminal session records (terminated/failed/expired) once they are
	 * older than the retention window. Without this, `_system/sessions/` grows
	 * unbounded — records are only ever status-flipped, never removed — and every
	 * list scan gets slower over time. Retention is measured from `last_heartbeat`,
	 * which is always <= the moment the session went terminal.
	 */
	async reapTerminated(retentionMs = TERMINAL_RETENTION_MS): Promise<number> {
		const now = Date.now();

		// Bounded-parallel scan; the actual removal is already a single batch delete.
		const candidates = await this.scanSessions((session, obj) =>
			isTerminal(session.status) && now - new Date(session.last_heartbeat).getTime() > retentionMs
				? obj.key
				: undefined,
		);
		const toDelete = candidates.filter((k): k is string => k !== undefined);

		if (toDelete.length > 0) {
			await this.bucket.delete(toDelete);
			this.metrics.increment('sessions.reaped', toDelete.length);
		}

		return toDelete.length;
	}
}
