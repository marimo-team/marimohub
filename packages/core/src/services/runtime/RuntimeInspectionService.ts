import { z } from 'zod';
import { StaleWhileRevalidateCache } from '../../cache';
import { BUCKET_SCAN_CONCURRENCY, SESSION_STATUSES } from '../../constants';
import { mapWithConcurrency } from '../../concurrency';
import type { NotebookId, ProjectId, SessionId } from '../../ids';
import { logOperationalError } from '../../operationalLog';
import { paths } from '../../paths';
import type { Bucket } from '../../ports/bucket';
import { SourceSchema } from '../../schema';
import type { Session } from '../../schema';
import type { CatalogService } from '../catalog/CatalogService';
import { AppPoolStore } from './AppPoolStore';
import { readForInspection } from './inspection';
import { expireAppPresence } from './AppPoolRouter';
import type { AppPool, AppPoolMember } from './AppPoolRouter';
import type { SessionService } from './SessionService';
import { PRESENT_STATUSES, sessionMode } from './sessionState';

const RuntimeAssignmentSchema = z.object({
	user_id: z.string(),
	visits: z.number().int().nonnegative(),
	state: z.enum(['active', 'grace']),
	expires_at: z.iso.datetime(),
});

const RuntimeSessionSchema = z.object({
	session_id: z.string(),
	sandbox_id: z.string().nullable(),
	user_id: z.string(),
	status: z.enum(SESSION_STATUSES).nullable(),
	started_at: z.iso.datetime(),
	last_heartbeat: z.iso.datetime().nullable(),
	source_version_id: z.string().nullable(),
	compute_profile: z.string().nullable(),
	active_connections: z.number().int().nonnegative().nullable(),
	connections_checked_at: z.iso.datetime().nullable(),
});

const RuntimeLocationSchema = z.object({
	project_id: z.string(),
	project_name: z.string(),
	notebook_id: z.string(),
	notebook_title: z.string(),
});

export const RuntimeSandboxSchema = RuntimeSessionSchema.extend({
	pool_state: z.enum(['starting', 'ready', 'draining', 'retiring']).nullable(),
	version_status: z.enum(['current', 'old', 'unknown']),
	legacy: z.boolean(),
	users: z.number().int().nonnegative().nullable(),
	idle_since: z.iso.datetime().nullable(),
	assignments: z.array(RuntimeAssignmentSchema),
	incomplete: z.boolean(),
});

export const RuntimeAppSchema = RuntimeLocationSchema.extend({
	current_version_id: z.string().nullable(),
	current_version_members: z.number().int().nonnegative().nullable(),
	sandboxes: z.array(RuntimeSandboxSchema),
	incomplete: z.boolean(),
});

export const RuntimeEditorSchema = RuntimeLocationSchema.extend(RuntimeSessionSchema.shape);

export const RuntimeInspectionSchema = z.object({
	observed_at: z.iso.datetime(),
	apps: z.array(RuntimeAppSchema),
	editors: z.array(RuntimeEditorSchema),
	incomplete: z.boolean(),
});

export type RuntimeInspection = z.infer<typeof RuntimeInspectionSchema>;
export type RuntimeApp = z.infer<typeof RuntimeAppSchema>;
export type RuntimeSandbox = z.infer<typeof RuntimeSandboxSchema>;

type Group = {
	projectId: ProjectId;
	notebookId: NotebookId;
	pool: AppPool | null;
	sessions: Session[];
	incomplete: boolean;
};

function sessionSummary(
	input:
		| { session: Session; member?: AppPoolMember }
		| { session?: undefined; member: AppPoolMember },
) {
	const { session, member } = input;
	const identity = session ?? member;
	return {
		session_id: identity.session_id,
		sandbox_id: session?.sandbox_id ?? member?.sandbox_id ?? null,
		user_id: identity.user_id,
		status: session?.status ?? null,
		started_at: session?.started_at ?? new Date(member!.created_at).toISOString(),
		last_heartbeat: session?.last_heartbeat ?? null,
		source_version_id: session?.source_version_id ?? member?.source_version_id ?? null,
		compute_profile: session?.compute_profile ?? null,
		active_connections: session?.active_connections ?? null,
		connections_checked_at: session?.connections_checked_at ?? null,
	};
}

export class RuntimeInspectionService {
	private readonly pools: AppPoolStore;
	private readonly cache: StaleWhileRevalidateCache<string, RuntimeInspection>;

	constructor(
		private readonly bucket: Bucket,
		private readonly sessions: SessionService,
		private readonly catalog: CatalogService,
		private readonly now: () => number = Date.now,
	) {
		this.pools = new AppPoolStore(bucket);
		this.cache = new StaleWhileRevalidateCache({
			load: () => this.load(),
			ttl: () => ({ freshForMs: 30_000, staleForMs: 0 }),
			maxSize: 1,
			now,
		});
	}

	inspect(): Promise<RuntimeInspection> {
		return this.cache.get('runtime');
	}

	private async load(): Promise<RuntimeInspection> {
		const [sessionScan, poolScan, catalogResult] = await Promise.all([
			this.sessions.inspectSessions(),
			this.pools.inspectAll(),
			this.catalog.getCurrentSnapshot().catch((error: unknown) => {
				logOperationalError('runtime_catalog_unavailable', { operation: 'runtime.inspect' }, error);
				return null;
			}),
		]);
		const now = this.now();
		const projects = new Map(catalogResult?.projects.map((project) => [project.id, project]));
		const notebooks = new Map(
			catalogResult?.projects.flatMap((project) =>
				project.notebooks.map((notebook) => [`${project.id}/${notebook.id}`, notebook] as const),
			),
		);
		const location = (projectId: ProjectId, notebookId: NotebookId) => ({
			project_id: projectId,
			project_name: projects.get(projectId)?.name ?? projectId,
			notebook_id: notebookId,
			notebook_title: notebooks.get(`${projectId}/${notebookId}`)?.title ?? notebookId,
		});
		const groups = new Map<string, Group>();
		const groupFor = (projectId: ProjectId, notebookId: NotebookId) => {
			const key = `${projectId}/${notebookId}`;
			let group = groups.get(key);
			if (!group) {
				group = { projectId, notebookId, pool: null, sessions: [], incomplete: false };
				groups.set(key, group);
			}
			return group;
		};
		for (const entry of poolScan.entries) {
			if (entry.pool?.members.length === 0) continue;
			const group = groupFor(entry.project_id, entry.notebook_id);
			group.pool = entry.pool;
			group.incomplete = entry.pool === null;
		}
		const allSessions = new Map(
			sessionScan.sessions.map((session) => [session.session_id, session]),
		);
		const present = sessionScan.sessions.filter((session) =>
			(PRESENT_STATUSES as readonly string[]).includes(session.status),
		);
		const editors: RuntimeInspection['editors'] = [];
		for (const session of present) {
			if (sessionMode(session) === 'app') {
				groupFor(session.project_id, session.notebook_id).sessions.push(session);
			} else {
				editors.push({
					...location(session.project_id, session.notebook_id),
					...sessionSummary({ session }),
				});
			}
		}
		const apps = await mapWithConcurrency(
			[...groups.values()],
			BUCKET_SCAN_CONCURRENCY,
			async (group): Promise<RuntimeApp> => {
				const source = await readForInspection(
					this.bucket,
					paths.project(group.projectId).notebook(group.notebookId).source,
					SourceSchema,
					'runtime.source',
				);
				const head = source?.current_version_id ?? null;
				if (!source) group.incomplete = true;
				const pool = group.pool ? structuredClone(group.pool) : null;
				const knownIdle = new Set([
					...(pool?.members
						.filter((member) => member.idle_since !== undefined)
						.map((member) => member.session_id) ?? []),
					...(pool?.assignments.map((assignment) => assignment.session_id) ?? []),
				]);
				if (pool) expireAppPresence(pool, now);
				const assignments = new Map<SessionId, RuntimeSandbox['assignments']>();
				for (const assignment of pool?.assignments ?? []) {
					const rows = assignments.get(assignment.session_id) ?? [];
					rows.push({
						user_id: assignment.user_id,
						visits: assignment.visits.length,
						state: assignment.visits.length > 0 ? 'active' : 'grace',
						expires_at: new Date(
							Math.max(
								assignment.grace_until ?? 0,
								...assignment.visits.map((visit) => visit.expires_at),
							),
						).toISOString(),
					});
					assignments.set(assignment.session_id, rows);
				}
				const members = new Map(pool?.members.map((member) => [member.session_id, member]));
				const ids = new Set([
					...members.keys(),
					...group.sessions.map((session) => session.session_id),
				]);
				const sandboxes = [...ids]
					.map((id): RuntimeSandbox => {
						const member = members.get(id);
						const session = allSessions.get(id);
						const summary = sessionSummary(session ? { session, member } : { member: member! });
						const legacy = member ? member.legacy === true : session?.app_pool !== true;
						const rows = assignments.get(id) ?? [];
						const incomplete = (!member && !legacy) || (!session && member?.state !== 'starting');
						return {
							...summary,
							pool_state: member?.state ?? null,
							version_status:
								!head || !summary.source_version_id
									? 'unknown'
									: summary.source_version_id === head
										? 'current'
										: 'old',
							legacy,
							users: member && !legacy ? rows.length : null,
							idle_since:
								member?.idle_since === undefined || !knownIdle.has(id)
									? null
									: new Date(member.idle_since).toISOString(),
							assignments: rows.sort((a, b) => a.user_id.localeCompare(b.user_id)),
							incomplete,
						};
					})
					.sort(
						(a, b) =>
							a.started_at.localeCompare(b.started_at) || a.session_id.localeCompare(b.session_id),
					);
				return {
					...location(group.projectId, group.notebookId),
					current_version_id: head,
					current_version_members:
						!head || group.incomplete
							? null
							: sandboxes.filter(
									(sandbox) =>
										!sandbox.legacy &&
										sandbox.version_status === 'current' &&
										(sandbox.pool_state === 'starting' || sandbox.pool_state === 'ready'),
								).length,
					sandboxes,
					incomplete: group.incomplete || sandboxes.some((sandbox) => sandbox.incomplete),
				};
			},
		);
		const byLocation = (
			a: z.infer<typeof RuntimeLocationSchema>,
			b: z.infer<typeof RuntimeLocationSchema>,
		) =>
			a.project_name.localeCompare(b.project_name) ||
			a.notebook_title.localeCompare(b.notebook_title) ||
			a.notebook_id.localeCompare(b.notebook_id);
		return {
			observed_at: new Date(now).toISOString(),
			apps: apps.sort(byLocation),
			editors: editors.sort(
				(a, b) =>
					byLocation(a, b) ||
					a.started_at.localeCompare(b.started_at) ||
					a.session_id.localeCompare(b.session_id),
			),
			incomplete:
				sessionScan.incomplete ||
				poolScan.incomplete ||
				!catalogResult ||
				apps.some((app) => app.incomplete),
		};
	}
}
