import { describe, expect, it, vi } from 'vitest';
import type { Metrics, Notification, Notifier } from '.';
import {
	fanOutNotifier,
	filterNotifier,
	NOTIFICATION_KINDS,
	NotificationSchema,
	notificationRouter,
	recipientFromIdentity,
	resolveMemberRecipient,
} from '.';
import { ids, makeProject, uid } from './testing/fixtures';

const project = makeProject({
	name: 'Forecasts',
	owner: uid('owner_notify'),
});

const notification: Notification = {
	schema_version: 1,
	kind: 'member.invited',
	severity: 'info',
	audience: 'personal',
	title: 'Invitation',
	body: 'You were invited.',
	recipients: [{ email: 'member@example.com' }],
	context: { pid: project.id },
	data: {
		project_id: project.id,
		project_name: project.name,
		role: 'editor',
		member_email: 'member@example.com',
		actor_user_id: uid('owner_notify'),
	},
	dedupe_key: 'member.invited:1:personal',
};

describe('NotificationRouter', () => {
	it('renders a member invitation with a recipient and absolute link', () => {
		const [rendered] = notificationRouter.render({
			kind: 'member.invited',
			project,
			member: { email: 'member@example.com', role: 'editor' },
			recipient: { email: 'member@example.com' },
			actor: { id: uid('owner_notify'), email: 'owner@example.com', name: 'Owner' },
			mutationId: 'event-1',
			baseUrl: 'https://hub.example.com/base',
		});

		expect(rendered).toMatchObject({
			schema_version: 1,
			kind: 'member.invited',
			audience: 'personal',
			title: 'You were invited to Forecasts',
			body: 'Owner invited you to Forecasts as editor.',
			link: `https://hub.example.com/projects/${project.id}`,
			recipients: [{ email: 'member@example.com' }],
			context: { pid: project.id, role: 'editor' },
			data: {
				project_id: project.id,
				project_name: 'Forecasts',
				role: 'editor',
				member_email: 'member@example.com',
				actor_user_id: uid('owner_notify'),
			},
		});
	});

	it('resolves an identity into a notification recipient', () => {
		expect(
			recipientFromIdentity({
				id: uid('member_notify'),
				email: 'member@example.com',
				name: 'Member',
				updated_at: '2026-08-11T12:00:00.000Z',
			}),
		).toEqual({ userId: uid('member_notify'), email: 'member@example.com', name: 'Member' });
	});

	it('omits a blank identity name', () => {
		expect(
			recipientFromIdentity({
				id: uid('blank_name'),
				email: 'member@example.com',
				name: '  ',
				updated_at: '2026-08-11T12:00:00.000Z',
			}),
		).toEqual({ userId: uid('blank_name'), email: 'member@example.com' });
	});

	it('rejects an identity with an invalid recipient email', () => {
		const memberId = uid('bad_email');
		const recipient = recipientFromIdentity({
			id: memberId,
			email: 'not-an-email',
			name: 'Member',
			updated_at: '2026-08-11T12:00:00.000Z',
		});
		expect(recipient).toBeNull();
		const [rendered] = notificationRouter.render({
			kind: 'member.added',
			project,
			member: { user_id: memberId, role: 'viewer' },
			recipient,
			actor: { id: uid('owner_notify'), email: 'owner@example.com' },
			mutationId: 'event-invalid-identity',
		});
		expect(NotificationSchema.parse(rendered).recipients).toEqual([]);
	});

	it('rejects an invalid pending-member email at the conversion boundary', () => {
		expect(resolveMemberRecipient({ email: 'not-an-email', role: 'viewer' }, null)).toBeNull();
	});

	it('accepts non-DNS email domains used by trusted identity providers', () => {
		expect(
			recipientFromIdentity({
				id: uid('local_email'),
				email: 'member@localhost',
				name: 'Member',
				updated_at: '2026-08-11T12:00:00.000Z',
			}),
		).toEqual({ userId: uid('local_email'), email: 'member@localhost', name: 'Member' });
	});

	it('renders a session takeover with the displaced editor and notebook link', () => {
		const rendered = notificationRouter.render({
			kind: 'session.takeover',
			project,
			notebookTitle: 'Revenue',
			projectId: project.id,
			notebookId: ids().notebook,
			takeoverId: 'takeover-123',
			displacedUserId: uid('editor_notify'),
			recipient: { userId: uid('editor_notify'), email: 'editor@example.com' },
			actor: { id: uid('other_editor'), email: 'other@example.com', name: 'Other editor' },
			baseUrl: 'https://hub.example.com',
		});

		expect(rendered).toHaveLength(2);
		expect(rendered[0]).toMatchObject({
			kind: 'session.takeover',
			severity: 'warning',
			audience: 'personal',
			body: 'Other editor took over Revenue in Forecasts.',
			link: `https://hub.example.com/projects/${project.id}/notebooks/${ids().notebook}`,
			recipients: [{ userId: uid('editor_notify'), email: 'editor@example.com' }],
			dedupe_key: 'session.takeover:takeover-123:personal',
		});
		expect(rendered[1]).toMatchObject({
			kind: 'session.takeover',
			audience: 'broadcast',
			body: 'Other editor took over Revenue in Forecasts, replacing editor@example.com.',
			recipients: [],
			dedupe_key: 'session.takeover:takeover-123:broadcast',
		});
		expect(rendered[0]?.data).toEqual(rendered[1]?.data);
	});

	it('keeps fixed-channel delivery when a member identity cannot be resolved', () => {
		const userId = uid('unknown_member');
		const [rendered] = notificationRouter.render({
			kind: 'member.added',
			project,
			member: { user_id: userId, role: 'viewer' },
			recipient: null,
			actor: { id: uid('owner_notify'), email: 'owner@example.com' },
			mutationId: 'event-2',
		});

		expect(rendered?.recipients).toEqual([]);
		expect(rendered?.dedupe_key).toBe('member.added:event-2:personal');
	});

	it('uses the registry as the notification-kind allowlist', () => {
		expect(NOTIFICATION_KINDS).toEqual(['member.invited', 'member.added', 'session.takeover']);
	});
});

describe('fanOutNotifier', () => {
	it('does nothing when the adapter list is empty', async () => {
		await expect(fanOutNotifier([]).deliver(notification)).resolves.toBe('skipped');
	});

	it('isolates a failed adapter when another adapter succeeds', async () => {
		const successful: Notifier = { deliver: vi.fn(async () => 'delivered' as const) };
		const failed: Notifier = {
			deliver: vi.fn(async () => {
				throw new Error('offline');
			}),
		};
		const metrics: Metrics = { increment: vi.fn(), gauge: vi.fn() };

		await expect(
			fanOutNotifier(
				[
					{ name: 'smtp', notifier: failed },
					{ name: 'webhook', notifier: successful },
				],
				metrics,
			).deliver(notification),
		).resolves.toBe('partial');

		expect(successful.deliver).toHaveBeenCalledWith(notification);
		expect(metrics.increment).toHaveBeenCalledWith('notify.deliver_failed', 1, {
			adapter: 'smtp',
			kind: notification.kind,
		});
		expect(metrics.increment).toHaveBeenCalledWith('notify.delivered', 1, {
			adapter: 'webhook',
			kind: notification.kind,
		});
	});

	it('throws when every adapter fails', async () => {
		const failed: Notifier = {
			deliver: async () => {
				throw new Error('offline');
			},
		};
		await expect(
			fanOutNotifier([
				{ name: 'smtp', notifier: failed },
				{ name: 'slack', notifier: failed },
			]).deliver(notification),
		).rejects.toThrow('No notification adapter delivered');
	});

	it('records an intentional adapter skip without counting a delivery', async () => {
		const skipped: Notifier = { deliver: vi.fn(async () => 'skipped' as const) };
		const metrics: Metrics = { increment: vi.fn(), gauge: vi.fn() };

		await expect(
			fanOutNotifier([{ name: 'smtp', notifier: skipped }], metrics).deliver(notification),
		).resolves.toBe('skipped');
		expect(metrics.increment).toHaveBeenCalledWith('notify.skipped', 1, {
			adapter: 'smtp',
			kind: notification.kind,
		});
		expect(metrics.increment).not.toHaveBeenCalledWith(
			'notify.delivered',
			expect.anything(),
			expect.anything(),
		);
	});

	it('fails when adapters only skip or fail', async () => {
		const skipped: Notifier = { deliver: vi.fn(async () => 'skipped' as const) };
		const failed: Notifier = {
			deliver: async () => {
				throw new Error('offline');
			},
		};

		await expect(
			fanOutNotifier([
				{ name: 'smtp', notifier: skipped },
				{ name: 'webhook', notifier: failed },
			]).deliver(notification),
		).rejects.toThrow('No notification adapter delivered');
	});

	it('filters disabled kinds', async () => {
		const target: Notifier = { deliver: vi.fn(async () => 'delivered' as const) };
		const filtered = filterNotifier(target, new Set(['session.takeover']));
		await expect(filtered.deliver(notification)).resolves.toBe('skipped');
		expect(target.deliver).not.toHaveBeenCalled();
	});
});

describe('NotificationSchema', () => {
	it.each([
		['an invalid recipient email', { recipients: [{ email: 'not-an-email' }] }],
		['a relative link', { link: '/projects/project_01' }],
		['an empty dedupe key', { dedupe_key: '' }],
		['a non-string context value', { context: { pid: 42 } }],
		['an unknown kind', { kind: 'job.failed' }],
		['a mismatched severity', { severity: 'error' }],
		['an unsupported audience', { audience: 'broadcast' }],
		['data for another kind', { data: { takeover_id: 'takeover-1' } }],
	])('rejects %s', (_label, replacement) => {
		expect(() => NotificationSchema.parse({ ...notification, ...replacement })).toThrow();
	});
});
