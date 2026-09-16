import { BadRequestError, foldCase, NotFoundError, NotebookId, ProjectId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, Project } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import {
	assertProjectActionOn,
	authorizationService,
	loadAuthorizedNotebook,
	loadVisibleProject,
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
	appAccess = false,
): Promise<Project> {
	const load = appAccess ? loadSessionProject : loadVisibleProject;
	if (ProjectId.is(value)) {
		return load(deps.services.projects, value, principal, deps);
	}
	const projects = await deps.services.projects.listProjects({
		action:
			appAccess && authorizationService(deps).credentialAllowsAction(principal, 'app.read')
				? 'app.read'
				: 'project.read',
		subject: principal,
		policy: deps.policy,
		resourceSecurity: deps.resourceSecurity,
	});
	const matches = projects.filter((project) => foldCase(project.name) === foldCase(value));
	if (matches.length === 0) throw new NotFoundError(`Project '${value}' not found`);
	if (matches.length > 1) {
		throw new BadRequestError(
			`Project name '${value}' is ambiguous; use one of: ${matches.map((item) => item.id).join(', ')}`,
		);
	}
	return load(deps.services.projects, matches[0].id, principal, deps);
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
		if (!match) throw new NotFoundError(`Notebook ${value} not found`);
		return match;
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
	action: 'project.read' | 'notebook.write',
) {
	const project = await resolveProject(deps, principal, projectRef);
	if (action === 'notebook.write') await assertProjectActionOn(project, principal, action, deps);
	const notebook = await resolveNotebook(deps, principal, project, notebookRef);
	const detail = await loadAuthorizedNotebook(deps, project, notebook.id, principal, action);
	return { project, notebook, detail };
}
