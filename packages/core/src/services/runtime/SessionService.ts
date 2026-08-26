import type { Bucket, BucketObject } from '../../ports/bucket';
import { noopMetrics } from '../../ports/metrics';
import type { Metrics } from '../../ports/metrics';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import type { EditorSandboxSharing, SessionMode } from '../../constants';
import { mapWithConcurrency } from '../../concurrency';
import { Millis } from '../../duration';
import {
	ConflictError,
	EditSessionChangedError,
	NotFoundError,
	PreconditionFailedError,
	TakeoverInProgressError,
} from '../../errors';
import {
	acquireSingletonClaim,
	mutateObject,
	mutateObjectWithOutcome,
	releaseSingletonClaim,
	withCasRetry,
} from '../catalog/cas';
import type { SingletonClaimConfig } from '../catalog/cas';
import { createSessionId } from '../../ids';
import type { NotebookId, ProjectId, SandboxId, SessionId, UserId, VersionId } from '../../ids';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import {
	AppClaimSchema,
	EditorClaimSchema,
	parseStored,
	readStored,
	SessionSchema,
	VersionPruneCutoffSchema,
} from '../../schema';
import type { EditorClaim, Session } from '../../schema';
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
	compute_resources?: Session['compute_resources'];
	compute_from_snapshot?: boolean;
	/** Discard-only session whose edits are never persisted (see SessionSchema). */
	ephemeral?: boolean;
	/** `edit` (default) or `app` (the shared singleton; see SessionSchema). */
	mode?: SessionMode;
	/** Immutable notebook version used to start this session. */
	source_version_id?: VersionId;
	editor_sandbox_sharing?: EditorSandboxSharing;
	/** Non-extendable expiry of the entitlement credential that authorized the session. */
	authorization_expires_at?: string;
	session_id?: SessionId;
}

const HEARTBEAT_TTL_MS = Millis.minutes(5);
const TERMINAL_RETENTION_MS = Millis.hours(24);
const TAKEOVER_REQUEST_TTL_MS = Millis.minutes(5);
const TAKEOVER_DRAIN_LEASE_MS = Millis.minutes(10);
const TAKEOVER_DRAIN_PROGRESS_TIMEOUT_MS = Millis.minutes(30);

// Coalesce heartbeat persistence: an already-running session is only re-written
// once its stored heartbeat is older than this. Bounds heartbeat writes to
// ~1/interval/session regardless of client cadence, while staying well within
// HEARTBEAT_TTL_MS so a live session is never spuriously expired.
const HEARTBEAT_PERSIST_INTERVAL_MS = Millis.seconds(60);

/** Sentinel for a session object that vanished between list and read. */
const SKIP = Symbol('missing-session');

export type TakeoverDrainStage = 'capturing' | 'snapshotting' | 'destroying' | 'finalizing';

const TAKEOVER_DRAIN_STAGE_ORDER: Record<TakeoverDrainStage, number> = {
	capturing: 0,
	snapshotting: 1,
	destroying: 2,
	finalizing: 3,
};

/**
 * Total order over session records — every replica derives the same queue
 * position from the same records, which is what lets the create route's cap
 * recheck pick one winner instead of every racer rejecting the others.
 */
const byCapOrder = (a: Session, b: Session) => {
	// A running session already cleared the cap and cannot be displaced by a new
	// starting record whose random id sorts first in the same millisecond.
	const admissionOrder = Number(a.status !== 'running') - Number(b.status !== 'running');
	return (
		admissionOrder ||
		a.started_at.localeCompare(b.started_at) ||
		a.session_id.localeCompare(b.session_id)
	);
};

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
	private async mutate(
		projectId: ProjectId,
		id: SessionId,
		apply: (session: Session) => Session | null,
	): Promise<Session> {
		const value = await mutateObject(
			this.bucket,
			paths.session(projectId, id),
			(raw) => parseStored(SessionSchema, raw, paths.session(projectId, id)),
			apply,
			{
				notFound: () => new NotFoundError(`Session ${id} not found`),
				onConflict: () => this.metrics.increment('sessions.cas.conflict'),
				onExhausted: () => this.metrics.increment('sessions.cas.exhausted'),
			},
		);
		return value;
	}

	async createSession(input: CreateSessionInput): Promise<Session> {
		const sessionId = input.session_id ?? createSessionId();
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
			...(input.editor_sandbox_sharing
				? { editor_sandbox_sharing: input.editor_sandbox_sharing }
				: {}),
			...(input.authorization_expires_at
				? { authorization_expires_at: input.authorization_expires_at }
				: {}),
			runtime: input.runtime,
			sandbox_id: input.sandbox_id,
			sandbox_url: input.sandbox_url,
			compute_profile: input.compute_profile,
			compute_resources: input.compute_resources,
			...(input.compute_from_snapshot ? { compute_from_snapshot: true } : {}),
		};

		const sessionPath = paths.session(input.project_id, sessionId);
		const written = await this.bucket.put(sessionPath, JSON.stringify(session));
		if (input.source_version_id) {
			let cutoff: VersionId | null;
			try {
				cutoff = await this.getVersionPruneCutoff(input.project_id, input.notebook_id);
			} catch (error) {
				await this.failCreatedSession(sessionPath, written.etag, session, {
					code: 'SOURCE_VERSION_CHECK_FAILED',
					message: 'The source version could not be verified',
				});
				throw error;
			}
			if (cutoff && input.source_version_id <= cutoff) {
				await this.failCreatedSession(sessionPath, written.etag, session, {
					code: 'SOURCE_VERSION_PRUNED',
					message: 'The source version is no longer available for a new session',
				});
				throw new ConflictError(
					'The source version is no longer available; reload the notebook and retry',
				);
			}
		}
		return session;
	}

	private async failCreatedSession(
		key: string,
		etag: string,
		session: Session,
		error: { code: string; message: string },
	): Promise<void> {
		try {
			await this.bucket.put(key, JSON.stringify({ ...session, status: 'failed', error }), {
				onlyIfEtagMatches: etag,
			});
		} catch (cause) {
			logOperationalError(
				'session_source_version_rejection_failed',
				{ operation: 'session.source_version.reject', object: key },
				cause,
			);
		}
	}

	private async getVersionPruneCutoff(
		projectId: ProjectId,
		notebookId: NotebookId,
	): Promise<VersionId | null> {
		const key = paths.versionPruneCutoff(projectId, notebookId);
		const object = await this.bucket.get(key);
		if (!object) return null;
		return (await readStored(VersionPruneCutoffSchema, object, key)).cutoff_version_id;
	}

	async advanceVersionPruneCutoff(
		projectId: ProjectId,
		notebookId: NotebookId,
		cutoff: VersionId,
	): Promise<void> {
		const key = paths.versionPruneCutoff(projectId, notebookId);
		await withCasRetry(this.bucket, async (cas) => {
			const existing = await this.bucket.get(key);
			if (!existing) {
				await cas.put(key, JSON.stringify({ cutoff_version_id: cutoff }), {
					onlyIfNotExists: true,
				});
				return;
			}
			const current = (await readStored(VersionPruneCutoffSchema, existing, key)).cutoff_version_id;
			if (current >= cutoff) return;
			await cas.put(key, JSON.stringify({ cutoff_version_id: cutoff }), {
				onlyIfEtagMatches: existing.etag,
			});
		});
	}

	async getSession(projectId: ProjectId, id: SessionId): Promise<Session> {
		const key = paths.session(projectId, id);
		const obj = await this.bucket.get(key);
		if (!obj) {
			throw new NotFoundError(`Session ${id} not found`);
		}

		return readStored(SessionSchema, obj, key);
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
		integrations?: Session['integrations'],
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
				...(session.integrations === undefined && integrations && integrations.length > 0
					? { integrations }
					: {}),
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

	/** Apply a credential deadline without ever extending an existing bound. */
	async tightenAuthorizationDeadline(
		projectId: ProjectId,
		id: SessionId,
		deadline: string,
	): Promise<Session> {
		return this.mutate(projectId, id, (session) => {
			if (
				session.authorization_expires_at !== undefined &&
				Date.parse(session.authorization_expires_at) <= Date.parse(deadline)
			) {
				return null;
			}
			return { ...session, authorization_expires_at: deadline };
		});
	}

	/** Record when the periodic snapshotter last saved this session. Pure cadence
	 * bookkeeping — never touches status, so it also applies to an `expired` record
	 * whose sandbox is still being snapshotted while editors remain connected. */
	async markSnapshotted(projectId: ProjectId, id: SessionId, at: string): Promise<Session> {
		return this.mutate(projectId, id, (session) => ({ ...session, last_snapshot_at: at }));
	}

	/** Record provider-confirmed sandbox destruction for claim fencing and reconciliation. */
	async markSandboxReclaimed(projectId: ProjectId, id: SessionId, at: string): Promise<Session> {
		return this.mutate(projectId, id, (session) => ({ ...session, sandbox_reclaimed_at: at }));
	}

	async markTakeoverCaptureCompleted(
		projectId: ProjectId,
		id: SessionId,
		at: string,
	): Promise<Session> {
		return this.mutate(projectId, id, (session) => ({
			...session,
			takeover_capture_completed_at: at,
		}));
	}

	/** Refresh a running session's heartbeat (keeps it off the TTL reaper).
	 * Coalesced to ~1 write/60s; never revives a terminal/terminating session.
	 * Provisioning owns the `starting` to `running` transition so a heartbeat
	 * cannot create a claim-holding session without a sandbox URL. */
	async heartbeat(projectId: ProjectId, id: SessionId): Promise<Session> {
		return this.mutate(projectId, id, (session) => {
			if (session.status !== 'running') return null;
			const ageMs = Date.now() - new Date(session.last_heartbeat).getTime();
			if (ageMs < HEARTBEAT_PERSIST_INTERVAL_MS) return null;
			return { ...session, last_heartbeat: new Date().toISOString() };
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
		attribution?: { reason: 'takeover'; by: UserId },
	): Promise<{ session: Session; transitioned: boolean }> {
		let transitioned = false;
		const session = await this.mutate(projectId, id, (current) => {
			const next = nextStatus(current.status, 'terminate');
			transitioned = next !== null;
			return next
				? {
						...current,
						status: next,
						...(attribution
							? { ended_reason: attribution.reason, ended_by_user_id: attribution.by }
							: {}),
					}
				: null;
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
		return (await this.markFailedWithOutcome(projectId, id, error)).session;
	}

	async markFailedWithOutcome(
		projectId: ProjectId,
		id: SessionId,
		error?: { code: string; message: string },
	): Promise<{ session: Session; transitioned: boolean }> {
		const path = paths.session(projectId, id);
		const result = await mutateObjectWithOutcome<Session>(
			this.bucket,
			path,
			(raw) => parseStored(SessionSchema, raw, path),
			(session) =>
				isTerminal(session.status) || session.status === 'terminating'
					? null
					: { ...session, status: 'failed' as const, ...(error ? { error } : {}) },
			{
				notFound: () => new NotFoundError(`Session ${id} not found`),
				onConflict: () => this.metrics.increment('sessions.cas.conflict'),
				onExhausted: () => this.metrics.increment('sessions.cas.exhausted'),
			},
		);
		return { session: result.value, transitioned: result.written };
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
				session = await readStored(SessionSchema, body, obj.key);
			} catch (err) {
				logOperationalError(
					'stored_object_skipped',
					{ operation: 'session.scan', object: obj.key },
					err,
				);
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

	async listProtectedVersionIds(
		projectId: ProjectId,
		notebookId: NotebookId,
	): Promise<ReadonlySet<VersionId>> {
		const sessions = await this.listActiveByProject(projectId);
		return new Set(
			sessions
				.filter((session) => session.notebook_id === notebookId && session.source_version_id)
				.map((session) => session.source_version_id as VersionId),
		);
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
	 * Reuse is keyed per the mode's `reuseScope`: `per-user` matches only
	 * the caller's own session; `per-notebook` is user-blind —
	 * ANY editor's request attaches. That user-blind reuse IS the singleton, so
	 * for a singleton mode the CLAIM, not the heartbeat order, decides which
	 * candidate is handed out.
	 *
	 * Persistent editor sessions use `findReusableEditor` instead. Their claim
	 * applies the deployment's shared or exclusive policy.
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

	async findReusableEditor(
		projectId: ProjectId,
		notebookId: NotebookId,
		userId: UserId,
		sharing: EditorSandboxSharing,
		temporary: boolean,
	): Promise<{
		session?: Session;
		ownedByOther?: Session;
		takeoverInProgress?: boolean;
		sharing: EditorSandboxSharing;
	}> {
		const now = Date.now();
		const sessions = await this.scanProject(projectId, (session) => session);
		const live = sessions.filter(
			(s) =>
				s.notebook_id === notebookId &&
				sessionMode(s) === 'edit' &&
				((s.status === 'running' && !!s.sandbox_url) ||
					(s.status === 'starting' && now - new Date(s.started_at).getTime() < HEARTBEAT_TTL_MS)),
		);
		if (temporary) {
			return {
				sharing,
				session: live
					.filter((s) => s.ephemeral && s.user_id === userId)
					.sort((a, b) => b.last_heartbeat.localeCompare(a.last_heartbeat))[0],
			};
		}
		const claim = await this.getEditorClaim(projectId, notebookId);
		if (!claim?.session_id) {
			const persistent = live.filter((session) => !session.ephemeral);
			if (persistent.length > 1) {
				throw new ConflictError(
					'Multiple legacy persistent editor sessions are active; drain them before continuing',
				);
			}
			if (persistent.length === 1) {
				const legacy = persistent[0];
				const adopted = await this.claimEditor(
					projectId,
					notebookId,
					legacy.session_id,
					legacy.editor_sandbox_sharing ?? sharing,
					legacy.user_id,
				);
				if (adopted.claim.session_id === legacy.session_id) {
					if (adopted.claim.sharing === 'shared' || legacy.user_id === userId) {
						return { sharing: adopted.claim.sharing, session: legacy };
					}
					return { sharing: adopted.claim.sharing, ownedByOther: legacy };
				}
			}
			const mismatched = live.find((session) => session.user_id === userId);
			if (mismatched) return { sharing, session: mismatched };
			return { sharing: claim?.sharing ?? sharing };
		}
		if (claim.transfer) {
			const replacement = claim.transfer.replacement_session_id
				? live.find((session) => session.session_id === claim.transfer?.replacement_session_id)
				: undefined;
			if (claim.transfer.phase === 'ready' && claim.transfer.requested_by === userId) {
				return { sharing: claim.sharing, session: replacement };
			}
			const holder = live.find((s) => s.session_id === claim.session_id);
			return { sharing: claim.sharing, ownedByOther: holder, takeoverInProgress: true };
		}
		const holder = live.find((s) => s.session_id === claim.session_id);
		if (!holder) return { sharing: claim.sharing };
		if (claim.sharing === 'shared' || holder.user_id === userId) {
			return { sharing: claim.sharing, session: holder };
		}
		return { sharing: claim.sharing, ownedByOther: holder };
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
			holder = (await readStored(AppClaimSchema, obj, paths.appClaim(projectId, notebookId)))
				.session_id;
		} catch (err) {
			logOperationalError(
				'stored_object_skipped',
				{
					operation: 'session.app_claim.read',
					object: paths.appClaim(projectId, notebookId),
				},
				err,
			);
			return undefined;
		}
		return holder ? candidates.find((s) => s.session_id === holder) : undefined;
	}

	/**
	 * Count a user's active sessions (`starting`/`running`) — `terminating` is
	 * excluded so a stop immediately frees a slot. The create-session route uses
	 * `listActiveForUser` to rank a new record for its concurrent-session cap; the
	 * per-notebook reuse in `findReusable` keeps refresh loops from tripping it.
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
			.sort(byCapOrder);
	}

	/**
	 * Count a project's active app sessions, for the per-project app cap
	 * (`MARIMOHUB_MAX_APPS_PER_PROJECT`). The user-blind reuse in `findReusable`
	 * keeps an attach from ever tripping it. `terminating` is excluded (matching
	 * the user cap): a stop frees the slot while teardown finishes, so the live
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
			.sort(byCapOrder);
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

	async getEditorClaim(
		projectId: ProjectId,
		notebookId: NotebookId,
	): Promise<EditorClaim | undefined> {
		const key = paths.editorClaim(projectId, notebookId);
		const obj = await this.bucket.get(key);
		if (!obj) return undefined;
		const claim = await readStored(EditorClaimSchema, obj, key);
		if (
			claim.transfer?.phase === 'requested' &&
			Date.now() - Date.parse(claim.transfer.requested_at) >= TAKEOVER_REQUEST_TTL_MS
		) {
			await this.cancelRequestedTakeover(projectId, notebookId, claim.transfer.takeover_id);
			const refreshed = await this.bucket.get(key);
			return refreshed ? readStored(EditorClaimSchema, refreshed, key) : undefined;
		}
		return claim;
	}

	private async holdsLiveEditor(
		projectId: ProjectId,
		notebookId: NotebookId,
		holder: SessionId,
	): Promise<boolean> {
		try {
			const session = await this.getSession(projectId, holder);
			if (
				session.notebook_id !== notebookId ||
				sessionMode(session) !== 'edit' ||
				session.ephemeral
			) {
				return false;
			}
			if (session.status === 'running') return true;
			if (
				session.status === 'starting' &&
				Date.now() - new Date(session.started_at).getTime() < HEARTBEAT_TTL_MS
			) {
				return true;
			}
			return (
				!!session.sandbox_id &&
				!session.sandbox_reclaimed_at &&
				(session.status === 'terminating' || isTerminal(session.status))
			);
		} catch (err) {
			if (err instanceof NotFoundError) return false;
			throw err;
		}
	}

	/** Acquire the single persistent editor claim. A live holder always wins. */
	async claimEditor(
		projectId: ProjectId,
		notebookId: NotebookId,
		sessionId: SessionId,
		sharing: EditorSandboxSharing,
		requestedBy?: UserId,
	): Promise<{ claimed: boolean; claim: EditorClaim }> {
		const key = paths.editorClaim(projectId, notebookId);
		return withCasRetry(
			this.bucket,
			async (cas) => {
				const obj = await this.bucket.get(key);
				const next: EditorClaim = {
					session_id: sessionId,
					sharing,
					claimed_at: new Date().toISOString(),
				};
				if (!obj) {
					await cas.put(key, JSON.stringify(next), { onlyIfNotExists: true });
					return { claimed: true, claim: next };
				}
				const current = await readStored(EditorClaimSchema, obj, key);
				if (current.session_id === sessionId) return { claimed: true, claim: current };
				if (current.transfer) {
					if (current.transfer.phase !== 'ready' || current.transfer.requested_by !== requestedBy) {
						throw new TakeoverInProgressError();
					}
					const reserved = current.transfer.replacement_session_id;
					if (reserved === sessionId) return { claimed: true, claim: current };
					if (reserved && (await this.holdsLiveEditor(projectId, notebookId, reserved))) {
						return {
							claimed: false,
							claim: { ...current, session_id: reserved },
						};
					}
					const reservedClaim: EditorClaim = {
						...current,
						transfer: { ...current.transfer, replacement_session_id: sessionId },
					};
					await cas.put(key, JSON.stringify(reservedClaim), {
						onlyIfEtagMatches: obj.etag,
					});
					return { claimed: true, claim: reservedClaim };
				}
				if (
					current.session_id &&
					(await this.holdsLiveEditor(projectId, notebookId, current.session_id))
				) {
					return { claimed: false, claim: current };
				}
				const replacement = { ...current, ...next, transfer: undefined };
				await cas.put(key, JSON.stringify(replacement), {
					onlyIfEtagMatches: obj.etag,
				});
				return { claimed: true, claim: replacement };
			},
			{
				onConflict: () => this.metrics.increment('sessions.editor_claim.conflict'),
				onExhausted: () => this.metrics.increment('sessions.editor_claim.exhausted'),
			},
		);
	}

	async ownsEditorClaim(session: Session): Promise<boolean> {
		const claim = await this.getEditorClaim(session.project_id, session.notebook_id);
		if (claim?.session_id) return claim.session_id === session.session_id;
		if (claim?.transfer || sessionMode(session) !== 'edit' || session.ephemeral) return false;

		// Upgrade compatibility: a lone pre-claim editor remains authoritative.
		// Multiple unreclaimed sandboxes are ambiguous, so none may persist until
		// an operator drains them instead of letting a lifecycle race pick a winner.
		const candidates = (await this.scanProject(session.project_id, (item) => item)).filter(
			(item) =>
				item.notebook_id === session.notebook_id &&
				sessionMode(item) === 'edit' &&
				!item.ephemeral &&
				!!item.sandbox_id &&
				!item.sandbox_reclaimed_at &&
				(item.session_id === session.session_id ||
					!isTerminal(item.status) ||
					item.status === 'expired'),
		);
		if (candidates.length !== 1 || candidates[0]?.session_id !== session.session_id) {
			if (candidates.length > 1) this.metrics.increment('sessions.editor_claim.legacy_conflict');
			return false;
		}
		const adopted = await this.claimEditor(
			session.project_id,
			session.notebook_id,
			session.session_id,
			session.editor_sandbox_sharing ?? 'shared',
			session.user_id,
		);
		return adopted.claim.session_id === session.session_id;
	}

	async releaseEditorFor(
		session: Pick<Session, 'project_id' | 'notebook_id' | 'session_id' | 'mode' | 'ephemeral'>,
	): Promise<void> {
		if (sessionMode(session) !== 'edit' || session.ephemeral) return;
		const key = paths.editorClaim(session.project_id, session.notebook_id);
		try {
			const obj = await this.bucket.get(key);
			if (!obj) return;
			const claim = await readStored(EditorClaimSchema, obj, key);
			if (claim.session_id !== session.session_id || claim.transfer) return;
			await this.bucket.put(
				key,
				JSON.stringify({ ...claim, session_id: null, claimed_at: new Date().toISOString() }),
				{ onlyIfEtagMatches: obj.etag },
			);
		} catch (err) {
			// A losing CAS means another request changed the claim, so this release
			// must not touch it. Other teardown failures are swallowed but logged.
			if (err instanceof PreconditionFailedError) return;
			this.metrics.increment('sessions.editor_claim.release_error');
			logOperationalError(
				'editor_claim_release_failed',
				{
					operation: 'session.editor_claim.release',
					object: key,
					session_id: session.session_id,
				},
				err,
			);
		}
	}

	async reserveTakeover(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: {
			takeoverId: string;
			requestedBy: UserId;
			expectedHolder: SessionId;
			expectedActivity: 'active' | 'idle' | 'unknown' | 'starting';
		},
	): Promise<EditorClaim> {
		return (await this.reserveTakeoverWithOutcome(projectId, notebookId, input)).value;
	}

	async reserveTakeoverWithOutcome(
		projectId: ProjectId,
		notebookId: NotebookId,
		input: {
			takeoverId: string;
			requestedBy: UserId;
			expectedHolder: SessionId;
			expectedActivity: 'active' | 'idle' | 'unknown' | 'starting';
		},
	): Promise<{ value: EditorClaim; written: boolean }> {
		return mutateObjectWithOutcome(
			this.bucket,
			paths.editorClaim(projectId, notebookId),
			(raw) => parseStored(EditorClaimSchema, raw, paths.editorClaim(projectId, notebookId)),
			(claim) => {
				if (claim.transfer?.takeover_id === input.takeoverId) {
					if (
						claim.transfer.requested_by !== input.requestedBy ||
						claim.session_id !== input.expectedHolder ||
						claim.transfer.expected_activity !== input.expectedActivity
					) {
						throw new EditSessionChangedError('The takeover ID was already used for another state');
					}
					return null;
				}
				const abandonedRequested =
					claim.transfer?.phase === 'requested' &&
					Date.now() - Date.parse(claim.transfer.requested_at) >= TAKEOVER_REQUEST_TTL_MS;
				if (claim.transfer && !abandonedRequested) throw new TakeoverInProgressError();
				if (claim.session_id !== input.expectedHolder) throw new EditSessionChangedError();
				return {
					...claim,
					transfer: {
						takeover_id: input.takeoverId,
						requested_by: input.requestedBy,
						expected_activity: input.expectedActivity,
						phase: 'requested' as const,
						requested_at: new Date().toISOString(),
					},
				};
			},
		);
	}

	async setTakeoverPhase(
		projectId: ProjectId,
		notebookId: NotebookId,
		takeoverId: string,
		phase: 'draining' | 'ready',
		replacementSessionId?: SessionId,
	): Promise<EditorClaim> {
		const value = await mutateObject(
			this.bucket,
			paths.editorClaim(projectId, notebookId),
			(raw) => parseStored(EditorClaimSchema, raw, paths.editorClaim(projectId, notebookId)),
			(claim) => {
				if (claim.transfer?.takeover_id !== takeoverId) throw new EditSessionChangedError();
				return {
					...claim,
					transfer: {
						...claim.transfer,
						phase,
						...(phase === 'ready'
							? {
									drain_lease_id: undefined,
									drain_lease_expires_at: undefined,
									drain_lease_stage: undefined,
									drain_lease_progress_deadline_at: undefined,
								}
							: {}),
						...(replacementSessionId ? { replacement_session_id: replacementSessionId } : {}),
					},
				};
			},
		);
		return value;
	}

	async acquireTakeoverDrainLease(
		projectId: ProjectId,
		notebookId: NotebookId,
		takeoverId: string,
		leaseId: string,
	): Promise<boolean> {
		const claim = await mutateObject(
			this.bucket,
			paths.editorClaim(projectId, notebookId),
			(raw) => parseStored(EditorClaimSchema, raw, paths.editorClaim(projectId, notebookId)),
			(claim) => {
				if (claim.transfer?.takeover_id !== takeoverId || claim.transfer.phase !== 'draining') {
					throw new EditSessionChangedError();
				}
				const activeLease =
					claim.transfer.drain_lease_id &&
					claim.transfer.drain_lease_expires_at &&
					Date.parse(claim.transfer.drain_lease_expires_at) > Date.now();
				if (activeLease && claim.transfer.drain_lease_id !== leaseId) return null;
				if (activeLease) return null;
				const now = Date.now();
				return {
					...claim,
					transfer: {
						...claim.transfer,
						drain_lease_id: leaseId,
						drain_lease_expires_at: new Date(now + TAKEOVER_DRAIN_LEASE_MS).toISOString(),
						drain_lease_stage: 'capturing' as const,
						drain_lease_progress_deadline_at: new Date(
							now + TAKEOVER_DRAIN_PROGRESS_TIMEOUT_MS,
						).toISOString(),
					},
				};
			},
		);
		return (
			claim.transfer?.drain_lease_id === leaseId &&
			Date.parse(claim.transfer.drain_lease_expires_at ?? '') > Date.now()
		);
	}

	async renewTakeoverDrainLease(
		projectId: ProjectId,
		notebookId: NotebookId,
		takeoverId: string,
		leaseId: string,
	): Promise<boolean> {
		const { written } = await mutateObjectWithOutcome(
			this.bucket,
			paths.editorClaim(projectId, notebookId),
			(raw) => parseStored(EditorClaimSchema, raw, paths.editorClaim(projectId, notebookId)),
			(claim) => {
				if (claim.transfer?.takeover_id !== takeoverId || claim.transfer.phase !== 'draining') {
					throw new EditSessionChangedError();
				}
				const now = Date.now();
				const expiresAt = Date.parse(claim.transfer.drain_lease_expires_at ?? '');
				const progressDeadline = Date.parse(
					claim.transfer.drain_lease_progress_deadline_at ??
						claim.transfer.drain_lease_expires_at ??
						'',
				);
				if (
					claim.transfer.drain_lease_id !== leaseId ||
					!Number.isFinite(expiresAt) ||
					!Number.isFinite(progressDeadline) ||
					expiresAt <= now ||
					progressDeadline <= now
				) {
					return null;
				}
				return {
					...claim,
					transfer: {
						...claim.transfer,
						drain_lease_expires_at: new Date(
							Math.min(now + TAKEOVER_DRAIN_LEASE_MS, progressDeadline),
						).toISOString(),
					},
				};
			},
		);
		return written;
	}

	async advanceTakeoverDrainLease(
		projectId: ProjectId,
		notebookId: NotebookId,
		takeoverId: string,
		leaseId: string,
		stage: TakeoverDrainStage,
	): Promise<boolean> {
		const claim = await mutateObject(
			this.bucket,
			paths.editorClaim(projectId, notebookId),
			(raw) => parseStored(EditorClaimSchema, raw, paths.editorClaim(projectId, notebookId)),
			(claim) => {
				if (claim.transfer?.takeover_id !== takeoverId || claim.transfer.phase !== 'draining') {
					throw new EditSessionChangedError();
				}
				const now = Date.now();
				const expiresAt = Date.parse(claim.transfer.drain_lease_expires_at ?? '');
				if (
					claim.transfer.drain_lease_id !== leaseId ||
					!Number.isFinite(expiresAt) ||
					expiresAt <= now
				) {
					return null;
				}
				const currentStage = claim.transfer.drain_lease_stage;
				if (
					currentStage &&
					TAKEOVER_DRAIN_STAGE_ORDER[stage] <= TAKEOVER_DRAIN_STAGE_ORDER[currentStage]
				) {
					return null;
				}
				return {
					...claim,
					transfer: {
						...claim.transfer,
						drain_lease_stage: stage,
						drain_lease_expires_at: new Date(now + TAKEOVER_DRAIN_LEASE_MS).toISOString(),
						drain_lease_progress_deadline_at: new Date(
							now + TAKEOVER_DRAIN_PROGRESS_TIMEOUT_MS,
						).toISOString(),
					},
				};
			},
		);
		return (
			claim.transfer?.drain_lease_id === leaseId &&
			claim.transfer.drain_lease_stage === stage &&
			Date.parse(claim.transfer.drain_lease_expires_at ?? '') > Date.now()
		);
	}

	async finishTakeoverDrainLease(
		projectId: ProjectId,
		notebookId: NotebookId,
		takeoverId: string,
		leaseId: string,
	): Promise<void> {
		await mutateObject(
			this.bucket,
			paths.editorClaim(projectId, notebookId),
			(raw) => parseStored(EditorClaimSchema, raw, paths.editorClaim(projectId, notebookId)),
			(claim) => {
				if (
					claim.transfer?.takeover_id !== takeoverId ||
					claim.transfer.phase !== 'draining' ||
					claim.transfer.drain_lease_id !== leaseId
				) {
					throw new EditSessionChangedError();
				}
				return {
					...claim,
					transfer: {
						...claim.transfer,
						phase: 'ready' as const,
						drain_lease_id: undefined,
						drain_lease_expires_at: undefined,
						drain_lease_stage: undefined,
						drain_lease_progress_deadline_at: undefined,
					},
				};
			},
		);
	}

	async releaseTakeoverDrainLease(
		projectId: ProjectId,
		notebookId: NotebookId,
		takeoverId: string,
		leaseId: string,
	): Promise<void> {
		try {
			await mutateObject(
				this.bucket,
				paths.editorClaim(projectId, notebookId),
				(raw) => parseStored(EditorClaimSchema, raw, paths.editorClaim(projectId, notebookId)),
				(claim) => {
					if (
						claim.transfer?.takeover_id !== takeoverId ||
						claim.transfer.drain_lease_id !== leaseId
					) {
						return null;
					}
					return {
						...claim,
						transfer: {
							...claim.transfer,
							drain_lease_id: undefined,
							drain_lease_expires_at: undefined,
							drain_lease_stage: undefined,
							drain_lease_progress_deadline_at: undefined,
						},
					};
				},
			);
		} catch (err) {
			this.metrics.increment('sessions.editor_claim.drain_lease_release_error');
			logOperationalError(
				'editor_claim_release_failed',
				{
					operation: 'session.takeover_drain_lease.release',
					object: paths.editorClaim(projectId, notebookId),
				},
				err,
			);
		}
	}

	async completeTakeover(
		projectId: ProjectId,
		notebookId: NotebookId,
		takeoverId: string,
		replacementSessionId: SessionId,
	): Promise<EditorClaim> {
		const value = await mutateObject(
			this.bucket,
			paths.editorClaim(projectId, notebookId),
			(raw) => parseStored(EditorClaimSchema, raw, paths.editorClaim(projectId, notebookId)),
			(claim) => {
				if (
					claim.transfer?.takeover_id !== takeoverId ||
					claim.transfer.phase !== 'ready' ||
					claim.transfer.replacement_session_id !== replacementSessionId
				) {
					throw new EditSessionChangedError();
				}
				return {
					...claim,
					session_id: replacementSessionId,
					sharing: 'exclusive' as const,
					claimed_at: new Date().toISOString(),
					transfer: undefined,
				};
			},
		);
		return value;
	}

	async cancelRequestedTakeover(
		projectId: ProjectId,
		notebookId: NotebookId,
		takeoverId: string,
	): Promise<void> {
		await mutateObject(
			this.bucket,
			paths.editorClaim(projectId, notebookId),
			(raw) => parseStored(EditorClaimSchema, raw, paths.editorClaim(projectId, notebookId)),
			(claim) =>
				claim.transfer?.takeover_id === takeoverId && claim.transfer.phase === 'requested'
					? { ...claim, transfer: undefined }
					: null,
		).catch((err) => {
			logOperationalError(
				'editor_claim_cancel_failed',
				{
					operation: 'session.takeover.cancel',
					object: paths.editorClaim(projectId, notebookId),
				},
				err,
			);
		});
	}

	/** The app-singleton lease over `_system/apps/{pid}/{nid}.json` (see AppClaimSchema). */
	private appClaimConfig(projectId: ProjectId, notebookId: NotebookId): SingletonClaimConfig {
		return {
			bucket: this.bucket,
			key: paths.appClaim(projectId, notebookId),
			serialize: (holder) =>
				JSON.stringify({ session_id: holder, claimed_at: new Date().toISOString() }),
			parseHolder: (raw) =>
				parseStored(AppClaimSchema, raw, paths.appClaim(projectId, notebookId)).session_id,
			isHolderLive: (holder) => this.holdsLiveApp(projectId, notebookId, holder as SessionId),
			onReleaseError: (err) => {
				this.metrics.increment('sessions.app_claim.release_error');
				logOperationalError(
					'app_claim_release_failed',
					{
						operation: 'session.app_claim.release',
						object: paths.appClaim(projectId, notebookId),
					},
					err,
				);
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
