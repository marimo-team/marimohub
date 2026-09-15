import { notificationRouter } from '@marimo-hub/core';
import type { AuthenticatedPrincipal, NotebookId, Project } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { assertNotificationMutationAllowed, scheduleProjectAlert } from '../notifications';
import { cancelJobRuns, retireLiveApps } from '../shared';

export async function deleteNotebookAndRetire(
	deps: ApiDeps,
	project: Project,
	notebookId: NotebookId,
	user: AuthenticatedPrincipal,
	expectedVersion?: string,
): Promise<void> {
	assertNotificationMutationAllowed(deps, user.id, { delivery: 'project-alert' });
	const deleted = await deps.services.notebooks.deleteNotebookWithMutation(
		project.id,
		notebookId,
		user.id,
		expectedVersion,
	);
	if (deleted) {
		scheduleProjectAlert(
			deps,
			project.id,
			'notebook.deleted',
			{ project_id: project.id, user: user.id },
			() =>
				notificationRouter.render({
					kind: 'notebook.deleted',
					project,
					notebookId,
					notebookTitle: deleted.notebook.title,
					actor: user,
					mutationId: deleted.mutationId,
					baseUrl: deps.sandbox.appBaseUrl,
				}),
		);
	}
	await retireLiveApps(deps, project.id, (session) => session.notebook_id === notebookId);
	await cancelJobRuns(deps, project.id, user.id, notebookId);
}
