import { describe, expect, it } from 'vitest';
import { UserId } from './ids';
import {
	GLOBAL_NOTIFICATION_KINDS,
	PROJECT_ALERT_KINDS,
	notificationRouter,
	NotificationSchema,
} from './notifications';
import { supportPageUrl } from './support';
import { AuthorizationService } from './services/authorization/AuthorizationService';

describe('support diagnostics', () => {
	it('renders diagnostics in the broadcast text and webhook data only', () => {
		const diagnostics = {
			reporter: { id: UserId.parse('reporter'), email: 'user@example.com' },
			page_url: 'https://hub.example/apps',
			hub_version: '1.2.3',
			timestamp: '2026-11-02T00:00:00.000Z',
			client: { user_agent: 'browser', viewport: { width: 800, height: 600 } },
		};
		const rendered = notificationRouter.render({
			kind: 'support.request',
			diagnostics,
			message: 'Cannot open app',
			requestId: 'request-1',
		});
		expect(rendered).toHaveLength(1);
		expect(NotificationSchema.parse(rendered[0])).toMatchObject({
			kind: 'support.request',
			audience: 'broadcast',
			recipients: [],
			data: { ...diagnostics, message: 'Cannot open app' },
			dedupe_key: 'support.request:request-1:broadcast',
		});
		expect(rendered[0].body).toContain('user@example.com');
		expect(rendered[0].body).toContain('1.2.3');
		expect(GLOBAL_NOTIFICATION_KINDS).toContain('support.request');
		expect(PROJECT_ALERT_KINDS).not.toContain('support.request');
	});

	it('removes URL credentials, search, and fragments', () => {
		expect(supportPageUrl('https://user:pass@hub.example/apps?token=secret#private')).toBe(
			'https://hub.example/apps',
		);
		expect(supportPageUrl('javascript:alert(1)')).toBe('');
		expect(supportPageUrl('broken')).toBe('');
	});

	it('allows app users while respecting credential grants', async () => {
		const authz = new AuthorizationService({ defaultRole: 'app-user' });
		const user = { id: UserId.parse('app-user'), email: 'user@example.com' };
		expect((await authz.authorize(user, 'support.request', { kind: 'deployment' })).allowed).toBe(
			true,
		);
		expect(
			(
				await authz.authorize(
					{
						...user,
						credential: {
							kind: 'personal-access-token',
							grant: { actions: ['project.read'], projects: '*' },
						},
					},
					'support.request',
					{ kind: 'deployment' },
				)
			).allowed,
		).toBe(false);
	});
});
