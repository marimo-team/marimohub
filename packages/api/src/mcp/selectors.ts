import {
	BadRequestError,
	effectiveRole,
	foldCase,
	NotFoundError,
	NotebookId,
	ProjectId,
	roleAtLeast,
} from '@marimo-hub/core';
import type { AuthenticatedPrincipal, Project } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import {
	assertProjectActionOn,
	authorizationService,
	loadAuthorizedNotebookMeta,
	loadSessionProject,
} from '../shared';

export const PROJECT_REFERENCE_DESCRIPTION =
	'Project ID or exact project name (case-insensitive). Use an ID if names are duplicated.';
export const NOTEBOOK_REFERENCE_DESCRIPTION =
	'Notebook ID or exact notebook title in the project (case-insensitive). Use an ID if titles are duplicated.';

export async function resolveProject(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	value: string,
	action:
		| 'project.read'
		| 'notebook.write'
		| 'working-branch.write'
		| 'integration.read'
		| 'integration.use' = 'project.read',
	appAccess = false,
): Promise<Project> {
	const integrationAction = action === 'integration.read' || action === 'integration.use';
	const loadProject = async (id: ProjectId) => {
		if (appAccess) return loadSessionProject(deps.services.projects, id, principal, deps);
		const project = await deps.services.projects.getProject(id);
		if (!integrationAction && effectiveRole(project, principal, deps.policy) === null) {
			throw new NotFoundError(`Project ${id} not found`);
		}
		await assertProjectActionOn(project, principal, action, deps);
		return project;
	};
	if (ProjectId.is(value)) {
		try {
			return await loadProject(value);
		} catch (error) {
			if (!(error instanceof NotFoundError)) throw error;
		}
	}
	const projects = await deps.services.projects.listProjects(
		action === 'project.read'
			? {
					action:
						appAccess && authorizationService(deps).credentialAllowsAction(principal, 'app.read')
							? 'app.read'
							: 'project.read',
					subject: principal,
					policy: deps.policy,
					resourceSecurity: deps.resourceSecurity,
				}
			: undefined,
	);
	let matches = projects.filter((project) => foldCase(project.name) === foldCase(value));
	if (action !== 'project.read') {
		// Scoped action grants need not include project.read; authorize exact candidates instead.
		const candidates = await Promise.all(
			matches.map((project) => deps.services.projects.getProject(project.id)),
		);
		const decisions = await authorizationService(deps).authorizeMany(
			principal,
			action,
			candidates.map((project) => ({ kind: 'project', project })),
		);
		matches = matches.filter((_, index) => decisions[index].allowed);
		if (integrationAction && matches.length === 0) {
			// Prefer allowed matches, but explain a denial to project readers. A name lookup must
			// not tell anyone else, app users included, that a private project with that name exists.
			for (const candidate of candidates) {
				if (!roleAtLeast(effectiveRole(candidate, principal, deps.policy), 'viewer')) continue;
				try {
					return await loadProject(candidate.id);
				} catch (error) {
					if (!(error instanceof NotFoundError)) throw error;
				}
			}
		}
	}
	if (matches.length === 0) throw new NotFoundError(`Project '${value}' not found`);
	if (matches.length > 1) {
		throw new BadRequestError(
			`Project name '${value}' is ambiguous; use one of: ${matches.map((item) => item.id).join(', ')}`,
		);
	}
	return loadProject(matches[0].id);
}

export async function resolveNotebook(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	project: Project,
	value: string,
) {
	const notebooks = await deps.services.notebooks.listNotebooks(project.id, {
		action: authorizationService(deps).appReadAction(principal, project),
		subject: principal,
		policy: deps.policy,
		resourceSecurity: deps.resourceSecurity,
	});
	if (NotebookId.is(value)) {
		const match = notebooks.find((notebook) => notebook.id === value);
		if (match) return match;
	}
	const matches = notebooks.filter((notebook) => foldCase(notebook.title) === foldCase(value));
	if (matches.length === 0) throw new NotFoundError(`Notebook '${value}' not found`);
	if (matches.length > 1) {
		throw new BadRequestError(
			`Notebook title '${value}' is ambiguous; use one of: ${matches.map((item) => item.id).join(', ')}`,
		);
	}
	return matches[0];
}

export async function resolveAuthorizedNotebook(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	projectRef: string,
	notebookRef: string,
	action: 'project.read' | 'notebook.write' | 'working-branch.write',
) {
	const project = await resolveProject(deps, principal, projectRef, action);
	if (NotebookId.is(notebookRef)) {
		const detail = await loadAuthorizedNotebookMeta(deps, project, notebookRef, principal, action);
		return { project, notebook: detail, detail };
	}
	const notebook = await resolveNotebook(deps, principal, project, notebookRef);
	const detail = await loadAuthorizedNotebookMeta(deps, project, notebook.id, principal, action);
	return { project, notebook, detail };
}
