import { z } from 'zod';
import { sessionMode } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, Session, VersionId } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { bestEffort } from '../log';
import { syncSourceManually } from '../routes/sourcePullSync';
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
	const outcome = await syncSourceManually(
		deps,
		project,
		notebook.id,
		principal,
		request,
		request.signal,
	);
	// A concurrent sync can move the source pointer past `outcome.version_id`, so
	// restart status compares against the reloaded pointer. The sync has already
	// committed; a failed lookup reports unknown restart status.
	const logFields = {
		request_id: request.requestId ?? null,
		project_id: project.id,
		notebook_id: notebook.id,
	};
	const lookup: { currentVersionId?: VersionId | null; active?: Session[] } = {};
	await bestEffort('mcp_sync_source_lookup', logFields, async () => {
		const { source } = await deps.services.notebooks.getNotebook(project.id, notebook.id);
		lookup.currentVersionId = source.current_version_id ?? null;
	});
	const currentVersionId = lookup.currentVersionId ?? null;
	await bestEffort('mcp_sync_session_lookup', logFields, async () => {
		lookup.active = await deps.services.sessions.listActiveByProject(project.id);
	});
	const sessions = lookup.active
		?.filter((session) => session.notebook_id === notebook.id)
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
		sessions: sessions ?? null,
		restart_needed: !sessions
			? null
			: sessions.some((session) => session.restart_needed === true)
				? true
				: sessions.some((session) => session.restart_needed === null)
					? null
					: false,
	};
}
