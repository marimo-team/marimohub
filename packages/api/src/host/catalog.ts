import {
	BUCKET_SCAN_CONCURRENCY,
	HostNotebookId,
	mapWithConcurrency,
	NotFoundError,
	sessionMode,
	workspaceSourceTypePolicy,
} from '@marimo-hub/core';
import type {
	AuthenticatedPrincipal,
	NotebookDetail,
	NotebookId,
	Project,
	ProjectId,
	PublicNotebookEntry,
	ResourceSecurityLabels,
	Session,
	Source,
} from '@marimo-hub/core';
import { OPERATIONS, RUNTIME_OPERATIONS } from '@marimo-hub/host-protocol';
import type { HostCatalogSnapshot, HostEvent, HostNotebookRecord } from '@marimo-hub/host-protocol';
import type { ApiDeps } from '../context';
import { withRequestMemo } from '../requestMemo';
import { authorizeMcpSession } from '../mcp/sessionActivity';
import { authorizationService, loadAuthorizedNotebook, loadVisibleProject } from '../shared';

export async function loadHostNotebook(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	id: string,
) {
	let parsed;
	try {
		parsed = HostNotebookId.parse(id);
	} catch {
		throw new NotFoundError('Notebook not found');
	}
	const project = await loadVisibleProject(
		deps.services.projects,
		parsed.projectId,
		principal,
		deps,
	);
	const notebook = await loadAuthorizedNotebook(
		deps,
		project,
		parsed.notebookId,
		principal,
		'project.read',
	);
	let session: Session | undefined;
	if (parsed.sessionId) {
		try {
			session = await deps.services.sessions.getSession(project.id, parsed.sessionId);
		} catch (error) {
			if (error instanceof NotFoundError) throw new NotFoundError('Notebook not found');
			throw error;
		}
	}
	if (session) {
		if (
			session.notebook_id !== notebook.meta.id ||
			sessionMode(session) !== 'edit' ||
			!session.ephemeral ||
			session.user_id !== principal.id ||
			!['starting', 'running'].includes(session.status)
		)
			throw new NotFoundError('Notebook not found');
		await authorizeMcpSession(deps, principal, session);
	}
	return { project, notebook, session };
}

export async function projectOperations(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	project: Project,
) {
	const decision = await authorizationService(deps).authorize(principal, 'notebook.write', {
		kind: 'project',
		project,
	});
	return decision.allowed ? ['notebook.create'] : [];
}

/** The notebook facts a host record needs, so callers supply them from whatever they loaded. */
export interface HostNotebookSubject {
	id: NotebookId;
	title: string;
	updated_at: string;
	sourceType: Source['type'];
	labels: ResourceSecurityLabels | null;
}

export function hostNotebookSubject(detail: NotebookDetail): HostNotebookSubject {
	return {
		id: detail.meta.id,
		title: detail.meta.title,
		updated_at: detail.meta.updated_at,
		sourceType: detail.source.type,
		labels: detail.meta.security_labels ?? null,
	};
}

async function listedNotebookSubject(
	deps: ApiDeps,
	project: Project,
	entry: PublicNotebookEntry,
): Promise<HostNotebookSubject> {
	return {
		id: entry.id,
		title: entry.title,
		updated_at: entry.updated_at,
		sourceType: entry.source_type,
		labels: await deps.services.notebooks.getSecurityLabels(project.id, entry.id, {
			consistency: 'validated',
		}),
	};
}

export async function notebookRecord(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	project: Project,
	notebook: HostNotebookSubject,
	session?: Session,
): Promise<HostNotebookRecord> {
	const authz = authorizationService(deps);
	const labels = notebook.labels;
	const [write, start, attach] = await Promise.all([
		authz.authorize(principal, 'notebook.write', {
			kind: 'project',
			project,
			notebookLabels: labels,
		}),
		authz.authorize(principal, 'session.start', {
			kind: 'session-start',
			project,
			mode: 'edit',
			notebookLabels: labels,
		}),
		authz.authorize(principal, 'session.attach', {
			kind: 'session',
			project,
			notebookLabels: labels,
			session: session ?? {
				mode: 'edit',
				ephemeral: false,
				user_id: principal.id,
				editor_sandbox_sharing: deps.policy.editorSandboxSharing,
			},
		}),
	]);
	return {
		id: HostNotebookId.create(project.id, notebook.id, session?.session_id),
		project_id: project.id,
		path: null,
		name: session ? `${notebook.title} (temporary)` : notebook.title,
		updated_at: notebook.updated_at,
		operations: [
			...(write.allowed && !session ? ['notebook.update'] : []),
			// A viewer's edit session is an ephemeral throwaway by policy (see startNotebookSession);
			// the hub exposes those only as temporary notebooks, never as a persistent record's runtime.
			...(start.allowed && start.role !== 'viewer' && attach.allowed
				? RUNTIME_OPERATIONS.filter((operation) =>
						operation === 'notebook.save'
							? !session &&
								write.allowed &&
								workspaceSourceTypePolicy(notebook.sourceType).persistSessionEdits
							: operation !== 'notebook.edit' || write.allowed,
					)
				: []),
		],
	};
}

export interface HostCatalog extends HostCatalogSnapshot {
	/** Present sessions per visible project, so runtime discovery need not list them again. */
	sessions: Map<ProjectId, Session[]>;
}

export async function catalogEvents(
	rawDeps: ApiDeps,
	principal: AuthenticatedPrincipal,
	signal?: AbortSignal,
): Promise<HostCatalog> {
	// SSE can refresh the catalog repeatedly after the caller's access changes.
	const deps = withRequestMemo(rawDeps);
	const events: HostEvent[] = [{ event: 'host', data: { host: { operations: OPERATIONS } } }];
	const sessionsByProject = new Map<ProjectId, Session[]>();
	const projects = await deps.services.projects.listProjects({
		subject: principal,
		policy: deps.policy,
		resourceSecurity: deps.resourceSecurity,
	});
	for (const entry of projects) {
		signal?.throwIfAborted();
		const project = await loadVisibleProject(deps.services.projects, entry.id, principal, deps);
		events.push({
			event: 'project',
			data: {
				project: {
					id: project.id,
					name: project.name,
					root: null,
					status: 'indexed',
					message: null,
					operations: await projectOperations(deps, principal, project),
				},
			},
		});
		const notebooks = await deps.services.notebooks.listNotebooks(project.id, {
			subject: principal,
			policy: deps.policy,
			resourceSecurity: deps.resourceSecurity,
		});
		const subjects = new Map<NotebookId, HostNotebookSubject>();
		const records = await mapWithConcurrency(
			notebooks,
			BUCKET_SCAN_CONCURRENCY,
			async (notebook) => {
				signal?.throwIfAborted();
				const subject = await listedNotebookSubject(deps, project, notebook);
				subjects.set(notebook.id, subject);
				return notebookRecord(deps, principal, project, subject);
			},
		);
		for (const notebook of records) events.push({ event: 'notebook', data: { notebook } });
		const sessions = await deps.services.sessions.listActiveByProject(project.id);
		sessionsByProject.set(project.id, sessions);
		for (const session of sessions) {
			if (!session.ephemeral || sessionMode(session) !== 'edit' || session.user_id !== principal.id)
				continue;
			const subject = subjects.get(session.notebook_id);
			if (!subject || !['starting', 'running'].includes(session.status)) continue;
			try {
				await authorizeMcpSession(deps, principal, session);
			} catch {
				continue;
			}
			events.push({
				event: 'notebook',
				data: {
					notebook: await notebookRecord(deps, principal, project, subject, session),
				},
			});
		}
	}
	return { events, sessions: sessionsByProject };
}
