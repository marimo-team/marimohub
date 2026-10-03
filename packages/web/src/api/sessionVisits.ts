import { apiClient } from './client';
import type { Session } from '@/types';

export function leaveAppVisit(
	projectId: string,
	notebookId: string,
	session: Pick<Session, 'session_id' | 'app_assignment'> | null,
) {
	if (!session?.app_assignment) return;
	void apiClient
		.POST('/api/v1/projects/{pid}/notebooks/{nid}/sessions/{sid}/leave', {
			params: { path: { pid: projectId, nid: notebookId, sid: session.session_id } },
			body: session.app_assignment,
			keepalive: true,
		})
		.catch(() => {});
}
