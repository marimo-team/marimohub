import {
	AppPoolService,
	logOperationalError,
	kernelActiveConnections,
	kernelBasePathFromUrl,
	NotebookId,
	NotFoundError,
	ProjectId,
	SessionRetirer,
	sessionOwner,
} from '@marimo-hub/core';
import type { ApiDeps } from './context';

export async function sweepAppPools(
	deps: Pick<ApiDeps, 'bucket' | 'services' | 'compute' | 'policy' | 'metrics'> & {
		sandbox: Pick<ApiDeps['sandbox'], 'persistWorkspace' | 'workdir' | 'sessionLifetime'>;
	},
): Promise<void> {
	const { sessions } = deps.services;
	const pool = new AppPoolService(deps.bucket, sessions, deps.policy.appPool, deps.metrics);
	const retirer = new SessionRetirer({
		...deps,
		...deps.services,
		persistWorkspace: deps.sandbox.persistWorkspace,
		workdir: deps.sandbox.workdir,
	});
	let cursor: string | undefined;
	do {
		const page = await deps.bucket.list({ prefix: '_system/app-pools/', cursor });
		for (const object of page.objects) {
			const match = /^_system\/app-pools\/([^/]+)\/([^/]+)\.json$/.exec(object.key);
			if (!match || !ProjectId.is(match[1]) || !NotebookId.is(match[2])) continue;
			const pid = match[1];
			const nid = match[2];
			await pool
				.reconcile(pid, nid, {
					probe: async (member) => {
						const session = await sessions.getSession(pid, member.session_id).catch((error) => {
							if (error instanceof NotFoundError) return null;
							throw error;
						});
						if (!session) return 0;
						if (
							session.authorization_expires_at &&
							Date.parse(session.authorization_expires_at) <= Date.now()
						)
							return 0;
						const connections = await kernelActiveConnections(
							deps.compute.create(member.sandbox_id, { owner: sessionOwner(session) }),
							kernelBasePathFromUrl(session.sandbox_url),
						);
						const idleTimeout = pool.policy.idleMs;
						return connections === null &&
							Date.now() - Date.parse(session.last_heartbeat) > idleTimeout
							? 0
							: connections;
					},
					retire: async (member, session) => {
						if (!session) {
							await deps.compute
								.create(member.sandbox_id, { owner: { projectId: pid, userId: member.user_id } })
								.destroy();
							return true;
						}
						if (session.sandbox_reclaimed_at) return true;
						const result = await sessions.beginTerminating(pid, session.session_id);
						if (!result.transitioned && result.session.status === 'terminating') return false;
						if (result.session.sandbox_reclaimed_at) return true;
						await retirer.retire(result.session, { captureBeforeDestroy: false });
						return !!(await sessions.getSession(pid, session.session_id)).sandbox_reclaimed_at;
					},
				})
				.catch((error) => {
					logOperationalError(
						'app_pool_sweep_failed',
						{ operation: 'app_pool.sweep', project_id: pid, notebook_id: nid },
						error,
					);
				});
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}
