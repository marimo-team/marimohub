import { NotebookId, ProjectId, UserId } from '..';
import type { Notification } from '..';

const projectId = ProjectId.parse('proj-0000000000000001');
const notebookId = NotebookId.parse('nb-0000000000000001');
const actorUserId = UserId.parse('owner-fixture');
const displacedUserId = UserId.parse('editor-fixture');

export const NOTIFICATION_FIXTURE: Notification = {
	schema_version: 1,
	kind: 'member.invited',
	severity: 'info',
	audience: 'personal',
	title: 'You were invited to Forecasts',
	body: 'Owner invited you to Forecasts as editor.',
	link: `https://hub.example.com/projects/${projectId}`,
	recipients: [{ email: 'member@example.com', name: 'Member' }],
	context: { pid: projectId, role: 'editor' },
	data: {
		project_id: projectId,
		project_name: 'Forecasts',
		role: 'editor',
		member_email: 'member@example.com',
		actor_user_id: actorUserId,
	},
	dedupe_key: 'member.invited:event-fixture:personal',
};

export const BROADCAST_NOTIFICATION_FIXTURE: Notification = {
	schema_version: 1,
	kind: 'session.takeover',
	severity: 'warning',
	audience: 'broadcast',
	title: 'Editor session takeover in Forecasts',
	body: 'Owner took over Revenue in Forecasts, replacing Editor.',
	link: `https://hub.example.com/projects/${projectId}/notebooks/${notebookId}`,
	recipients: [],
	context: { pid: projectId, nid: notebookId, takeover_id: 'takeover-fixture' },
	data: {
		project_id: projectId,
		project_name: 'Forecasts',
		notebook_id: notebookId,
		notebook_title: 'Revenue',
		takeover_id: 'takeover-fixture',
		actor_user_id: actorUserId,
		displaced_user_id: displacedUserId,
	},
	dedupe_key: 'session.takeover:takeover-fixture:broadcast',
};
