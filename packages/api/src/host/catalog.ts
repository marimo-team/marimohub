import {
	HostNotebookId,
	NotFoundError,
	sessionMode,
	workspaceSourcePolicy,
} from '@marimo-hub/core';
import type {
	AuthenticatedPrincipal,
	NotebookMeta,
	Project,
	PublicNotebookEntry,
	Session,
} from '@marimo-hub/core';
import type { HostEvent } from '@marimo-hub/core/host-bridge';
import type { ApiDeps } from '../context';
import { authorizeMcpSession } from '../mcp/sessionActivity';
import { authorizationService, loadAuthorizedNotebook, loadVisibleProject } from '../shared';
import { OPERATIONS, RUNTIME_OPERATIONS } from './protocol';

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
	const session = parsed.sessionId
		? await deps.services.sessions.getSession(project.id, parsed.sessionId)
		: undefined;
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

export async function notebookRecord(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	project: Project,
	notebook: NotebookMeta | PublicNotebookEntry,
	session?: Session,
) {
	const authz = authorizationService(deps);
	const labels = await deps.services.notebooks.getSecurityLabels(project.id, notebook.id, {
		consistency: 'validated',
	});
	const detail = await deps.services.notebooks.getNotebook(project.id, notebook.id);
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
				editor_sandbox_sharing: deps.policy.editorSandboxSharing ?? 'shared',
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
			...(start.allowed && start.role !== 'viewer' && attach.allowed
				? RUNTIME_OPERATIONS.filter((operation) =>
						operation === 'notebook.save'
							? !session &&
								write.allowed &&
								workspaceSourcePolicy(detail.source).persistSessionEdits
							: operation !== 'notebook.edit' || write.allowed,
					)
				: []),
		],
	};
}

export async function catalogEvents(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
): Promise<HostEvent[]> {
	const events: HostEvent[] = [{ event: 'host', data: { host: { operations: OPERATIONS } } }];
	const projects = await deps.services.projects.listProjects({
		subject: principal,
		policy: deps.policy,
		resourceSecurity: deps.resourceSecurity,
	});
	for (const entry of projects) {
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
		for (const notebook of notebooks) {
			events.push({
				event: 'notebook',
				data: { notebook: await notebookRecord(deps, principal, project, notebook) },
			});
		}
		for (const session of await deps.services.sessions.listActiveByProject(project.id)) {
			if (!session.ephemeral || sessionMode(session) !== 'edit' || session.user_id !== principal.id)
				continue;
			const notebook = notebooks.find((entry) => entry.id === session.notebook_id);
			if (!notebook || !['starting', 'running'].includes(session.status)) continue;
			try {
				await authorizeMcpSession(deps, principal, session);
			} catch {
				continue;
			}
			events.push({
				event: 'notebook',
				data: { notebook: await notebookRecord(deps, principal, project, notebook, session) },
			});
		}
	}
	return events;
}
