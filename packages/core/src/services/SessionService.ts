import type { Bucket } from '../ports/bucket';
import { type Metrics, noopMetrics } from '../ports/metrics';
import { NotFoundError } from '../errors';
import { createSessionId, type NotebookId, type ProjectId, type SessionId } from '../ids';
import { paths } from '../paths';
import { SessionSchema, type Session } from '../schema';

export interface CreateSessionInput {
	notebook_id: NotebookId;
	project_id: ProjectId;
	user_id: string;
	runtime?: { python_version?: string; marimo_version?: string };
	sandbox_id?: string;
	sandbox_url?: string;
}

const HEARTBEAT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
// Coalesce heartbeat persistence: an already-running session is only re-written
// once its stored heartbeat is older than this. Bounds heartbeat writes to
// ~1/interval/session regardless of client cadence, while staying well within
// HEARTBEAT_TTL_MS so a live session is never spuriously expired.
const HEARTBEAT_PERSIST_INTERVAL_MS = 60 * 1000; // 60 seconds

export class SessionService {
	constructor(
		private bucket: Bucket,
		private metrics: Metrics = noopMetrics,
	) {}

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
			runtime: input.runtime,
			sandbox_id: input.sandbox_id,
			sandbox_url: input.sandbox_url,
		};

		await this.bucket.put(paths.session(sessionId), JSON.stringify(session));
		return session;
	}

	async getSession(id: SessionId): Promise<Session> {
		const obj = await this.bucket.get(paths.session(id));
		if (!obj) {
			throw new NotFoundError(`Session ${id} not found`);
		}

		return SessionSchema.parse(await obj.json());
	}

	async setRunning(id: SessionId, sandboxUrl: string, usedFallback?: boolean): Promise<Session> {
		const obj = await this.bucket.get(paths.session(id));
		if (!obj) {
			throw new NotFoundError(`Session ${id} not found`);
		}

		const session = SessionSchema.parse(await obj.json());
		const updated: Session = {
			...session,
			status: 'running',
			sandbox_url: sandboxUrl,
			used_fallback: usedFallback,
		};

		await this.bucket.put(paths.session(id), JSON.stringify(updated));
		return updated;
	}

	async heartbeat(id: SessionId): Promise<Session> {
		const obj = await this.bucket.get(paths.session(id));
		if (!obj) {
			throw new NotFoundError(`Session ${id} not found`);
		}

		const session = SessionSchema.parse(await obj.json());

		// A terminal session must not be revived by a late heartbeat. Return the
		// unchanged session without writing so the reaper can still collect it.
		if (session.status === 'terminated' || session.status === 'expired') {
			return session;
		}

		// Coalesce: skip the write if the session is already running and its
		// stored heartbeat is still fresh. The first heartbeat (status not yet
		// `running`) and any heartbeat past the interval are persisted.
		const ageMs = Date.now() - new Date(session.last_heartbeat).getTime();
		if (session.status === 'running' && ageMs < HEARTBEAT_PERSIST_INTERVAL_MS) {
			return session;
		}

		const updated: Session = {
			...session,
			status: 'running',
			last_heartbeat: new Date().toISOString(),
		};

		await this.bucket.put(paths.session(id), JSON.stringify(updated));
		return updated;
	}

	async terminate(id: SessionId): Promise<Session> {
		const obj = await this.bucket.get(paths.session(id));
		if (!obj) {
			throw new NotFoundError(`Session ${id} not found`);
		}

		const session = SessionSchema.parse(await obj.json());
		const updated: Session = {
			...session,
			status: 'terminated',
		};

		await this.bucket.put(paths.session(id), JSON.stringify(updated));
		return updated;
	}

	async listSessions(notebookId?: NotebookId): Promise<Session[]> {
		const result = await this.bucket.list({ prefix: paths.sessionsPrefix });

		const sessions: Session[] = [];
		for (const obj of result.objects) {
			const body = await this.bucket.get(obj.key);
			if (body) {
				const session = SessionSchema.parse(await body.json());
				if (!notebookId || session.notebook_id === notebookId) {
					sessions.push(session);
				}
			}
		}

		return sessions;
	}

	/**
	 * Count a user's non-terminal sessions (`starting`/`running`/`idle`). The
	 * create-session route uses this to enforce a concurrent-session cap — a
	 * cost-DoS guard against a runaway client provisioning unbounded billable
	 * sandboxes. Soft/best-effort (count→create is not atomic), which is
	 * acceptable under the trusted-user model.
	 */
	async countActiveForUser(userId: string): Promise<number> {
		const sessions = await this.listSessions();
		return sessions.filter(
			(s) =>
				s.user_id === userId &&
				(s.status === 'starting' || s.status === 'running' || s.status === 'idle'),
		).length;
	}

	async expireStale(): Promise<number> {
		const result = await this.bucket.list({ prefix: paths.sessionsPrefix });
		const now = Date.now();
		let expired = 0;
		let live = 0;

		for (const obj of result.objects) {
			const body = await this.bucket.get(obj.key);
			if (!body) continue;

			const session = SessionSchema.parse(await body.json());
			const isLive =
				session.status === 'running' || session.status === 'idle' || session.status === 'starting';
			if (isLive && now - new Date(session.last_heartbeat).getTime() > HEARTBEAT_TTL_MS) {
				const updated: Session = { ...session, status: 'expired' };
				await this.bucket.put(obj.key, JSON.stringify(updated));
				expired++;
			} else if (isLive) {
				live++;
			}
		}

		// `live` is the live-sandbox/session count an operator can't otherwise
		// infer; cost should be derived from the compute provider (see operations.md).
		this.metrics.gauge('sessions.live', live);
		if (expired > 0) this.metrics.increment('sessions.expired', expired);

		return expired;
	}

	/**
	 * Delete terminal session records (terminated/expired) once they are older
	 * than the retention window. Without this, `_system/sessions/` grows
	 * unbounded — records are only ever status-flipped, never removed — and
	 * every list scan gets slower over time. Retention is measured from
	 * `last_heartbeat`, which is always <= the moment the session went terminal.
	 */
	async reapTerminated(retentionMs = TERMINAL_RETENTION_MS): Promise<number> {
		const result = await this.bucket.list({ prefix: paths.sessionsPrefix });
		const now = Date.now();
		const toDelete: string[] = [];

		for (const obj of result.objects) {
			const body = await this.bucket.get(obj.key);
			if (!body) continue;

			const session = SessionSchema.parse(await body.json());
			if (
				(session.status === 'terminated' || session.status === 'expired') &&
				now - new Date(session.last_heartbeat).getTime() > retentionMs
			) {
				toDelete.push(obj.key);
			}
		}

		if (toDelete.length > 0) {
			await this.bucket.delete(toDelete);
			this.metrics.increment('sessions.reaped', toDelete.length);
		}

		return toDelete.length;
	}
}
