import type { Session } from './schema';

export function sessionResourceNotebookId(session: Pick<Session, 'notebook_id' | 'origin'>) {
	return session.origin?.notebook_id ?? session.notebook_id;
}

export function sessionResourcePath(
	session: Pick<Session, 'project_id' | 'notebook_id' | 'origin'>,
): string {
	const notebook = `/projects/${session.project_id}/notebooks/${sessionResourceNotebookId(session)}`;
	return session.origin ? `${notebook}/previews/${session.origin.preview_id}` : notebook;
}
