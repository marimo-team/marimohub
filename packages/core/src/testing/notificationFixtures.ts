import type { Notification } from '..';

export const NOTIFICATION_FIXTURE: Notification = {
	kind: 'member.invited',
	severity: 'info',
	title: 'You were invited to Forecasts',
	body: 'Owner invited you to Forecasts as editor.',
	link: 'https://hub.example.com/projects/project_01',
	recipients: [{ email: 'member@example.com', name: 'Member' }],
	context: { pid: 'project_01', role: 'editor' },
	dedupe_key: 'member.invited:project_01:member@example.com',
};
