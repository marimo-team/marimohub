import { BoundedLruMap } from '@marimo-hub/core/cache';
import {
	AppPoolService,
	AppPoolStore,
	DEFAULT_APP_POOL_POLICY,
	mapWithConcurrency,
	routeAppRetirement,
	logOperationalError,
	kernelActiveConnections,
	localKernelBasePath,
	NotebookId,
	NotebookMetaSchema,
	PreviewRuntimeMetaSchema,
	StoredObjectError,
	readStored,
	paths,
	NotFoundError,
	ProjectId,
	SessionRetirer,
	sessionSandbox,
	sessionMode,
} from '@marimo-hub/core';
import type { Bucket, Metrics } from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { previewAppPoolPolicy } from './previewPolicy';

const inertPools = new WeakMap<Bucket, BoundedLruMap<string, string>>();

export async function sweepAppPools(
	deps: Pick<
		ApiDeps,
		'bucket' | 'services' | 'compute' | 'policy' | 'metrics' | 'backgroundWork'
	> & {
		sandbox: Pick<ApiDeps['sandbox'], 'persistWorkspace' | 'workdir' | 'sessionLifetime'>;
	},
): Promise<void> {
	const { sessions } = deps.services;
	const cached = inertPools.get(deps.bucket) ?? new BoundedLruMap<string, string>(10_000);
	const next = new BoundedLruMap<string, string>(10_000);
	inertPools.set(deps.bucket, cached);
	const projectSessions = new Map<ProjectId, ReturnType<typeof sessions.listActiveByProject>>();
	const readSessions = (pid: ProjectId) => {
		let pending = projectSessions.get(pid);
		if (!pending) {
			pending = sessions
				.listActiveByProject(pid)
				.then((rows) => rows.filter((session) => sessionMode(session) === 'app'));
			projectSessions.set(pid, pending);
		}
		return pending;
	};
	const sweepSessions = new Proxy(sessions, {
		get(target, property) {
			if (property === 'listActiveByProject') return readSessions;
			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	const store = new AppPoolStore(deps.bucket);
	const previewPolicy = previewAppPoolPolicy(deps.policy.appPool);
	let visits = 0;
	let complete = true;

	const retirer = new SessionRetirer({
		...deps,
		...deps.services,
		persistWorkspace: deps.sandbox.persistWorkspace,
		workdir: deps.sandbox.workdir,
	});
	let cursor: string | undefined;
	do {
		const page = await deps.bucket.list({ prefix: '_system/app-pools/', cursor });
		await mapWithConcurrency(page.objects, 8, async (object) => {
			const match = /^_system\/app-pools\/([^/]+)\/([^/]+)\.json$/.exec(object.key);
			if (!match || !ProjectId.is(match[1]) || !NotebookId.is(match[2])) return;
			const pid = match[1];
			const nid = match[2];
			try {
				if (object.etag && cached.get(object.key) === object.etag) {
					next.set(object.key, object.etag);
					return;
				}
				const known = await store.readWithEtag(pid, nid);
				const snapshot = known?.value;
				if (!snapshot) return;
				let poolVisits = snapshot.assignments.length;
				visits += poolVisits;
				if (
					snapshot.deleted_at !== undefined &&
					snapshot.members.length === 0 &&
					snapshot.assignments.length === 0
				) {
					next.set(object.key, known.etag);
					return;
				}
				if (
					snapshot.members.length === 0 &&
					snapshot.assignments.length === 0 &&
					!(await readSessions(pid)).some((session) => session.notebook_id === nid)
				)
					return;
				const notebook = paths.project(pid).notebook(nid);
				let metaKey = notebook.meta;
				let metaObject = await deps.bucket.get(metaKey);
				if (!metaObject) {
					metaKey = notebook.previewMeta;
					metaObject = await deps.bucket.get(metaKey);
				}
				const isRuntime = metaKey === notebook.previewMeta && !!metaObject;
				const meta = metaObject
					? await readStored(
							isRuntime ? PreviewRuntimeMetaSchema : NotebookMetaSchema,
							metaObject,
							metaKey,
						).catch((error) => {
							if (!(error instanceof StoredObjectError)) throw error;
							logOperationalError(
								'app_pool_metadata_unreadable',
								{ operation: 'app_pool.sweep', project_id: pid, notebook_id: nid },
								error,
							);
							return null;
						})
					: null;
				// A corrupt runtime must retain preview bounds and startup protection.
				const isPreview = isRuntime || !!meta?.preview;
				const policy = isPreview ? previewPolicy : (deps.policy.appPool ?? DEFAULT_APP_POOL_POLICY);
				const now = Date.now();
				const needsSync =
					snapshot.deleted_at !== undefined ||
					snapshot.members.length === 0 ||
					snapshot.members.some((member) => {
						return (
							(member.idle_since === undefined &&
								!snapshot.assignments.some(
									(assignment) => assignment.session_id === member.session_id,
								)) ||
							routeAppRetirement(snapshot, member, policy, now) !== 'retain'
						);
					}) ||
					snapshot.assignments.some(
						(assignment) =>
							assignment.visit_id === undefined ||
							assignment.visits.some((visit) => visit.expires_at <= now) ||
							(assignment.visits.length === 0 && (assignment.grace_until ?? 0) <= now),
					);
				if (!needsSync) {
					const active = await readSessions(pid);
					const changed = snapshot.members.some((member) => {
						const session = active.find((session) => session.session_id === member.session_id);
						return (
							!session ||
							session.status === 'terminating' ||
							(session.authorization_expires_at &&
								Date.parse(session.authorization_expires_at) <= now)
						);
					});
					if (!changed) return;
				}
				const metrics: Metrics = {
					increment: (name, value, tags) => deps.metrics?.increment(name, value, tags),
					histogram: (name, value, tags) => deps.metrics?.histogram?.(name, value, tags),
					gauge: (name, value, tags) => {
						if (name === 'app_pool.visits') {
							visits += value - poolVisits;
							poolVisits = value;
						} else deps.metrics?.gauge(name, value, tags);
					},
				};
				const pool = new AppPoolService(deps.bucket, sweepSessions, policy, metrics);
				await pool.reconcile(pid, nid, {
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
							sessionSandbox(deps.compute, session, deps.metrics, 'app_pool'),
							localKernelBasePath(session),
						).catch((error: unknown) => {
							if (error instanceof NotFoundError) return null;
							throw error;
						});
						const idleTimeout = pool.policy.idleMs;
						return connections === null &&
							Date.now() - Date.parse(session.last_heartbeat) > idleTimeout
							? 0
							: connections;
					},
					retire: async (member, session) => {
						if (
							isPreview &&
							session?.status === 'starting' &&
							member.operation_expires_at > Date.now()
						)
							return false;
						if (!session) {
							const existing = deps.compute.connectExisting?.(member.sandbox_id, {
								owner: { projectId: pid, userId: member.user_id },
							});
							if (!existing) return false;
							await existing.destroy();
							return true;
						}
						if (session.sandbox_reclaimed_at) return true;
						const result = await sessions.beginTerminating(pid, session.session_id);
						if (!result.transitioned && result.session.status === 'terminating') return false;
						if (result.session.sandbox_reclaimed_at) return true;
						await retirer.retire(result.session, { captureBeforeDestroy: false });
						return !!(await sessions.getSession(pid, session.session_id)).sandbox_reclaimed_at;
					},
				});
			} catch (error) {
				complete = false;
				logOperationalError(
					'app_pool_sweep_failed',
					{ operation: 'app_pool.sweep', project_id: pid, notebook_id: nid },
					error,
				);
			}
		});
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	if (complete) inertPools.set(deps.bucket, next);
	if (complete) deps.metrics?.gauge('app_pool.visits', visits);
}
