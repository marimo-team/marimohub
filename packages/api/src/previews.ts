import { AppPoolStore, logOperationalError, NotFoundError, sessionMode } from '@marimo-hub/core';
import type { NotebookId, NotebookPreview, ProjectId } from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { sessionRetirer } from './shared';

export async function cleanupPreview(deps: ApiDeps, record: NotebookPreview): Promise<void> {
	await deps.services.previews.cleanup(record, (pid, nid) => retirePreviewRuntime(deps, pid, nid));
}

async function retirePreviewRuntime(
	deps: ApiDeps,
	pid: NotebookPreview['project_id'],
	nid: NotebookPreview['notebook_id'],
): Promise<boolean> {
	let complete = true;
	const sessions = await deps.services.sessions.listByProject(pid, nid);
	const pool = sessions.some(
		(session) =>
			sessionMode(session) === 'app' &&
			(session.status === 'starting' || session.status === 'expired'),
	)
		? await new AppPoolStore(deps.bucket).read(pid, nid)
		: null;
	const members = new Map(pool?.members.map((member) => [member.session_id, member]));
	for (const session of sessions) {
		const startupDeadline =
			members.get(session.session_id)?.operation_expires_at ??
			Date.parse(session.started_at) + Math.max(deps.sandbox.startupTimeoutMs ?? 900_000, 900_000);
		// Another maintenance cycle may have expired a session still provisioning.
		if (
			(session.status === 'starting' ||
				(session.status === 'expired' &&
					(!session.authorization_expires_at ||
						Date.now() < Date.parse(session.authorization_expires_at)))) &&
			Date.now() < startupDeadline
		) {
			complete = false;
			continue;
		}
		if (session.sandbox_reclaimed_at) continue;
		try {
			const result = await deps.services.sessions.beginTerminating(pid, session.session_id);
			if (!result.transitioned && result.session.status === 'terminating') {
				complete = false;
				continue;
			}
			if (result.session.sandbox_reclaimed_at) continue;
			await sessionRetirer(deps).retire(result.session, { captureBeforeDestroy: false });
			if (!(await deps.services.sessions.getSession(pid, session.session_id)).sandbox_reclaimed_at)
				complete = false;
		} catch (error) {
			complete = false;
			logOperationalError(
				'preview_cleanup_failed',
				{ operation: 'preview.cleanup', session_id: session.session_id },
				error,
			);
		}
	}
	return complete;
}

export async function sweepPreviews(deps: ApiDeps): Promise<void> {
	const projectRuntimes = new Map<ProjectId, Promise<Set<NotebookId>>>();
	const hasRuntime = async (pid: ProjectId, nid: NotebookId): Promise<boolean> => {
		let runtimes = projectRuntimes.get(pid);
		if (!runtimes) {
			runtimes = deps.services.sessions
				.listByProject(pid)
				.then(
					(sessions) =>
						new Set(
							sessions
								.filter((session) => !session.sandbox_reclaimed_at)
								.map((session) => session.notebook_id),
						),
				);
			projectRuntimes.set(pid, runtimes);
		}
		return (await runtimes).has(nid);
	};
	for (let record of await deps.services.previews.cleanupCandidates()) {
		try {
			if (record.state === 'active') {
				const project = await deps.services.projects
					.getProject(record.project_id)
					.catch((error) => {
						if (error instanceof NotFoundError) return null;
						throw error;
					});
				const parent = await deps.services.notebooks
					.getNotebookMeta(record.project_id, record.notebook_id)
					.catch((error) => {
						if (error instanceof NotFoundError) return null;
						throw error;
					});
				if (
					!project ||
					project.status === 'deleted' ||
					!parent ||
					parent.status === 'deleted' ||
					Date.parse(record.expires_at) <= Date.now()
				)
					record = await deps.services.previews.retire(record);
			}
			if (record.state !== 'active') await cleanupPreview(deps, record);
			else {
				record = await deps.services.previews.reapAdmissions(record, async (sid) => {
					try {
						return !(await deps.services.sessions.getSession(record.project_id, sid))
							.sandbox_reclaimed_at;
					} catch (error) {
						if (error instanceof NotFoundError) return;
						throw error;
					}
				});
				await deps.services.previews.prune(
					record,
					(nid) => hasRuntime(record.project_id, nid),
					// Recheck sessions after fencing admission; discovery may predate a launch.
					(pid, nid) => retirePreviewRuntime(deps, pid, nid),
				);
			}
		} catch (error) {
			logOperationalError(
				'preview_reconciliation_failed',
				{ operation: 'preview.reconcile', preview_id: record.id },
				error,
			);
		}
	}
}

export async function retireNotebookPreviews(
	deps: ApiDeps,
	pid: NotebookPreview['project_id'],
	nid?: NotebookPreview['notebook_id'],
): Promise<void> {
	const logFailure = (error: unknown, previewId?: string) =>
		logOperationalError(
			'preview_retirement_failed',
			{ operation: 'preview.retire', project_id: pid, notebook_id: nid, preview_id: previewId },
			error,
		);
	let records: NotebookPreview[];
	try {
		records = await deps.services.previews.projectRecords(pid, nid);
	} catch (error) {
		logFailure(error);
		return;
	}
	for (const record of records) {
		try {
			await deps.services.previews.retire(record);
		} catch (error) {
			logFailure(error, record.id);
		}
	}
}

export async function preparePreviews(deps: ApiDeps, signal?: AbortSignal): Promise<void> {
	if (!deps.sourceControl) return;
	await deps.services.previews.preparePending(deps.sourceControl, signal);
}
