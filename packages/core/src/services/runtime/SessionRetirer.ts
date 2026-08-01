import type { Bucket } from '../../ports/bucket';
import type { SandboxProvider } from '../../ports/sandbox';
import type { Session } from '../../schema';
import type { NotebookService } from '../content/NotebookService';
import { SandboxProvisioner } from './SandboxProvisioner';
import { sessionPersistsEdits } from './sessionState';
import type { SessionService } from './SessionService';

export interface SessionRetirerDeps {
	sessions: SessionService;
	notebooks: NotebookService;
	compute: SandboxProvider;
	bucket: Bucket;
	persistWorkspace: 'source' | 'workspace';
	workdir?: string;
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
	 * record terminated, release any singleton claim it holds.
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
		opts: { teardown?: boolean; markTerminated?: boolean } = {},
	): Promise<void> {
		if (opts.teardown !== false) await this.teardownSandbox(session);
		if (opts.markTerminated !== false) {
			await this.deps.sessions
				.markTerminated(session.project_id, session.session_id)
				.catch(() => {});
		}
		await this.deps.sessions.releaseAppFor(session);
		await this.deps.sessions.releaseEditorFor(session);
	}

	/** Save and stop an exclusive editor without releasing its protected claim. */
	async retireForTakeover(session: Session, requestedBy: Session['user_id']): Promise<void> {
		if (session.sandbox_id) {
			const sandbox = this.deps.compute.create(session.sandbox_id);
			await this.provisioner.captureSession(
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
		}
		await this.deps.sessions.beginTerminating(session.project_id, session.session_id, {
			reason: 'takeover',
			by: requestedBy,
		});
		if (session.sandbox_id) await this.deps.compute.create(session.sandbox_id).destroy();
		await this.deps.sessions.markTerminated(session.project_id, session.session_id);
	}

	async completeTakeoverDrain(session: Session): Promise<void> {
		if (session.sandbox_id) await this.deps.compute.create(session.sandbox_id).destroy();
		await this.deps.sessions.markTerminated(session.project_id, session.session_id);
	}

	/**
	 * Reclaim the sandbox behind an already-terminal record: save first when the
	 * content is still authoritative (`save`), then destroy. `teardown` swallows
	 * destroy failures, so the destroy is re-confirmed here (idempotent per the
	 * compute contract) before stamping the one-shot `sandbox_reclaimed_at`
	 * marker — a failed destroy leaves the marker unset and the next sweep
	 * retries. Returns whether the sandbox is confirmed gone.
	 */
	async reclaim(session: Session, save: boolean): Promise<boolean> {
		if (save) await this.teardownSandbox(session);
		if (session.sandbox_id) {
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
	 * Best-effort save-and-destroy. Persistence follows `sessionPersistsEdits`;
	 * edits are attributed to the session's owner, not whoever triggered the
	 * stop. `teardown` swallows its own step failures; the catch guards a throw
	 * before its destroy so a sandbox can never linger and bill.
	 */
	private async teardownSandbox(session: Session): Promise<void> {
		if (!session.sandbox_id) return;
		const sandbox = this.deps.compute.create(session.sandbox_id);
		try {
			const persistEdits =
				sessionPersistsEdits(session) && (await this.deps.sessions.ownsEditorClaim(session));
			await this.provisioner.teardown(
				sandbox,
				this.deps.notebooks,
				this.deps.bucket,
				session.project_id,
				session.notebook_id,
				session.user_id,
				this.deps.persistWorkspace,
				this.deps.workdir,
				{
					persistEdits,
					computeProfile: session.compute_profile,
					computeResources: session.compute_resources,
				},
			);
		} catch {
			await sandbox.destroy().catch(() => {});
		}
	}
}
