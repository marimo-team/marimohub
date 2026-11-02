import { z } from 'zod';
import { sessionMode } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { syncSourceManually } from '../routes/sourcePullSync';
import { loadAuthorizedNotebook } from '../shared';
import {
	resolveAuthorizedNotebook,
	PROJECT_REFERENCE_DESCRIPTION,
	NOTEBOOK_REFERENCE_DESCRIPTION,
} from './selectors';
import type { StartRequestContext } from './server';

const referenceSchema = z.string().min(1).regex(/\S/, 'Must not be blank');
export const SyncNotebookSourceInputSchema = z.strictObject({
	project: referenceSchema.describe(PROJECT_REFERENCE_DESCRIPTION),
	notebook: referenceSchema.describe(NOTEBOOK_REFERENCE_DESCRIPTION),
});

export async function syncNotebookSource(
	deps: ApiDeps,
	principal: AuthenticatedPrincipal,
	request: StartRequestContext,
	projectRef: string,
	notebookRef: string,
) {
	const { project, notebook } = await resolveAuthorizedNotebook(
		deps,
		principal,
		projectRef,
		notebookRef,
		'notebook.write',
	);
	const outcome = await syncSourceManually(deps, project, notebook.id, principal, request);
	const { source } = await loadAuthorizedNotebook(
		deps,
		project,
		notebook.id,
		principal,
		'notebook.write',
	);
	const currentVersionId = source.current_version_id ?? null;
	const active = await deps.services.sessions.listActiveByProject(project.id);
	const sessions = active
		.filter((session) => session.notebook_id === notebook.id)
		.map((session) => ({
			session_id: session.session_id,
			mode: sessionMode(session),
			status: session.status,
			source_version_id: session.source_version_id ?? null,
			restart_needed:
				currentVersionId === null || session.source_version_id === undefined
					? null
					: session.source_version_id !== currentVersionId,
		}));
	return {
		project_id: project.id,
		notebook_id: notebook.id,
		...outcome,
		current_version_id: currentVersionId,
		sessions,
		restart_needed: sessions.some((session) => session.restart_needed === true)
			? true
			: sessions.some((session) => session.restart_needed === null)
				? null
				: false,
	};
}
