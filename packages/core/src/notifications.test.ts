import { describe, expect, it, vi } from 'vitest';
import type { Metrics, Notification, Notifier } from '.';
import {
	fanOutNotifier,
	filterNotifier,
	NOTIFICATION_KINDS,
	PROJECT_ALERT_KINDS,
	NotificationSchema,
	notificationRouter,
	recipientFromIdentity,
	reduceNotificationDeliveryResults,
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

	it('uses neutral broadcast copy when the displaced identity is unresolved', () => {
		const displacedUserId = uid('opaque-provider-subject');
		const rendered = notificationRouter.render({
			kind: 'session.takeover',
			project,
			notebookTitle: 'Revenue',
			projectId: project.id,
			notebookId: ids().notebook,
			takeoverId: 'takeover-unresolved',
			displacedUserId,
			recipient: null,
			actor: { id: uid('other_editor'), email: 'other@example.com', name: 'Other editor' },
		});

		expect(rendered[0]).toMatchObject({ audience: 'personal', recipients: [] });
		expect(rendered[1]).toMatchObject({
			audience: 'broadcast',
			body: 'Other editor took over Revenue in Forecasts, replacing another editor.',
		});
		expect(rendered[1]?.body).not.toContain(displacedUserId);
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
		expect(PROJECT_ALERT_KINDS).toEqual([
			'member.invited',
			'member.added',
			'member.role_changed',
			'member.removed',
			'session.takeover',
			'notebook.deleted',
			'project.deleted',
			'app.start_failed',
			'app.unavailable',
			'sync.failed',
		]);
		expect(Object.isFrozen(NOTIFICATION_KINDS)).toBe(true);
		expect(Object.isFrozen(PROJECT_ALERT_KINDS)).toBe(true);
	});

	it.each([
		[
			'member.invited',
			() =>
				notificationRouter.render({
					kind: 'member.invited',
					project,
					member: { email: 'member@example.com', role: 'editor' },
					recipient: { email: 'member@example.com' },
					actor: { id: uid('render_actor'), email: 'owner@example.com' },
					mutationId: 'render-invited',
				}),
		],
		[
			'member.added',
			() =>
				notificationRouter.render({
					kind: 'member.added',
					project,
					member: { user_id: uid('render_member'), role: 'viewer' },
					recipient: {
						userId: uid('render_member'),
						email: 'member@example.com',
					},
					actor: { id: uid('render_actor'), email: 'owner@example.com' },
					mutationId: 'render-added',
				}),
		],
		[
			'member.role_changed',
			() =>
				notificationRouter.render({
					kind: 'member.role_changed',
					project,
					member: { email: 'member@example.com', role: 'editor' },
					oldRole: 'viewer',
					actor: { id: uid('render_actor'), email: 'owner@example.com' },
					mutationId: 'render-role',
				}),
		],
		[
			'member.removed',
			() =>
				notificationRouter.render({
					kind: 'member.removed',
					project,
					member: { email: 'member@example.com', role: 'editor' },
					actor: { id: uid('render_actor'), email: 'owner@example.com' },
					mutationId: 'render-removed',
				}),
		],
		[
			'session.takeover',
			() =>
				notificationRouter.render({
					kind: 'session.takeover',
					project,
					notebookTitle: 'Revenue',
					projectId: project.id,
					notebookId: ids().notebook,
					takeoverId: 'render-takeover',
					displacedUserId: uid('render_displaced'),
					recipient: { email: 'displaced@example.com' },
					actor: { id: uid('render_actor'), email: 'owner@example.com' },
				}),
		],
		[
			'notebook.deleted',
			() =>
				notificationRouter.render({
					kind: 'notebook.deleted',
					project,
					notebookId: ids().notebook,
					notebookTitle: 'Revenue',
					actor: { id: uid('render_actor'), email: 'owner@example.com' },
					mutationId: 'render-notebook-deleted',
				}),
		],
		[
			'project.deleted',
			() =>
				notificationRouter.render({
					kind: 'project.deleted',
					project,
					actor: { id: uid('render_actor'), email: 'owner@example.com' },
					mutationId: 'render-project-deleted',
				}),
		],
		[
			'app.start_failed',
			() =>
				notificationRouter.render({
					kind: 'app.start_failed',
					project,
					notebookId: ids().notebook,
					notebookTitle: 'Revenue',
					sessionId: ids().session,
					startedByUserId: uid('render_starter'),
					errorCode: 'START_FAILED',
				}),
		],
		[
			'app.unavailable',
			() =>
				notificationRouter.render({
					kind: 'app.unavailable',
					project,
					notebookId: ids().notebook,
					notebookTitle: 'Revenue',
					sessionId: ids().session,
					startedByUserId: uid('render_starter'),
					errorCode: 'APP_STOPPED',
				}),
		],
		[
			'sync.failed',
			() =>
				notificationRouter.render({
					kind: 'sync.failed',
					project,
					notebookId: ids().notebook,
					notebookTitle: 'Revenue',
					commit: '1234567890abcdef',
					errorCode: 'SYNC_FAILED',
				}),
		],
	] as const)('renders valid envelopes for %s', (kind, render) => {
		const rendered = render();
		expect(rendered.length).toBeGreaterThan(0);
		expect(rendered.every((item) => item.kind === kind)).toBe(true);
		for (const item of rendered) expect(() => NotificationSchema.parse(item)).not.toThrow();
	});

	it('renders stable app-failure data without provider error text', () => {
		const [rendered] = notificationRouter.render({
			kind: 'app.start_failed',
			project,
			notebookId: ids().notebook,
			notebookTitle: 'Revenue',
			sessionId: ids().session,
			startedByUserId: uid('app_starter'),
			errorCode: 'PROVISION_FAILED',
			baseUrl: 'https://hub.example.com',
		});

		expect(rendered).toMatchObject({
			kind: 'app.start_failed',
			severity: 'error',
			audience: 'broadcast',
			data: { error_code: 'PROVISION_FAILED', session_id: ids().session },
			dedupe_key: `app.start_failed:${ids().session}:broadcast`,
		});
		expect(JSON.stringify(rendered)).not.toContain('provider');
	});

	it('renders member role changes and removals with stable member identity data', () => {
		const actor = { id: uid('owner_notify'), email: 'owner@example.com', name: 'Owner' };
		const member = { email: 'member@example.com', role: 'editor' as const };
		const [roleChanged] = notificationRouter.render({
			kind: 'member.role_changed',
			project,
			member,
			oldRole: 'viewer',
			actor,
			mutationId: 'role-1',
			baseUrl: 'https://hub.example.com',
		});
		const [removed] = notificationRouter.render({
			kind: 'member.removed',
			project,
			member,
			actor,
			mutationId: 'remove-1',
			baseUrl: 'https://hub.example.com',
		});

		expect(roleChanged).toMatchObject({
			kind: 'member.role_changed',
			severity: 'warning',
			audience: 'broadcast',
			body: 'Owner changed member@example.com from viewer to editor.',
			data: { member_email: 'member@example.com', old_role: 'viewer', new_role: 'editor' },
			dedupe_key: 'member.role_changed:role-1:broadcast',
		});
		expect(removed).toMatchObject({
			kind: 'member.removed',
			body: 'Owner removed member@example.com from Forecasts.',
			data: { member_email: 'member@example.com', role: 'editor' },
			dedupe_key: 'member.removed:remove-1:broadcast',
		});
	});

	it('renders notebook and project deletion alerts', () => {
		const actor = { id: uid('owner_notify'), email: 'owner@example.com' };
		const [notebookDeleted] = notificationRouter.render({
			kind: 'notebook.deleted',
			project,
			notebookId: ids().notebook,
			notebookTitle: 'Revenue',
			actor,
			mutationId: 'notebook-delete-1',
			baseUrl: 'https://hub.example.com',
		});
		const [projectDeleted] = notificationRouter.render({
			kind: 'project.deleted',
			project,
			actor,
			mutationId: 'project-delete-1',
		});

		expect(notebookDeleted).toMatchObject({
			kind: 'notebook.deleted',
			body: 'owner@example.com deleted Revenue.',
			context: { pid: project.id, nid: ids().notebook },
			data: { notebook_title: 'Revenue', actor_user_id: actor.id },
			dedupe_key: 'notebook.deleted:notebook-delete-1:broadcast',
		});
		expect(projectDeleted).toMatchObject({
			kind: 'project.deleted',
			title: 'Project deleted: Forecasts',
			data: { project_id: project.id, actor_user_id: actor.id },
			dedupe_key: 'project.deleted:project-delete-1:broadcast',
		});
		expect(projectDeleted).not.toHaveProperty('link');
	});

	it('renders unavailable-app and sync-failure alerts', () => {
		const notebookId = ids().notebook;
		const sessionId = ids().session;
		const [unavailable] = notificationRouter.render({
			kind: 'app.unavailable',
			project,
			notebookId,
			notebookTitle: 'Revenue',
			sessionId,
			startedByUserId: uid('app_starter'),
			errorCode: 'SANDBOX_DISAPPEARED',
			baseUrl: 'https://hub.example.com',
		});
		const [syncFailed] = notificationRouter.render({
			kind: 'sync.failed',
			project,
			notebookId,
			notebookTitle: 'Revenue',
			commit: '1234567890abcdef',
			errorCode: 'SYNC_FAILED',
			baseUrl: 'https://hub.example.com',
		});

		expect(unavailable).toMatchObject({
			kind: 'app.unavailable',
			title: 'App unavailable in Forecasts',
			body: 'Revenue stopped unexpectedly (SANDBOX_DISAPPEARED).',
			dedupe_key: `app.unavailable:${sessionId}:broadcast`,
		});
		expect(syncFailed).toMatchObject({
			kind: 'sync.failed',
			body: 'Revenue failed to sync commit 1234567890ab (SYNC_FAILED).',
			data: { commit: '1234567890abcdef', error_code: 'SYNC_FAILED' },
			dedupe_key: `sync.failed:${notebookId}:1234567890abcdef:broadcast`,
		});
	});

	it('renders a complete test alert envelope', () => {
		const destinationId = 'alert-0123456789abcdef' as never;
		const [rendered] = notificationRouter.render({
			kind: 'alert.test',
			project,
			destinationId,
			actor: { id: uid('owner_notify'), email: 'owner@example.com' },
			testId: 'test-request-1',
		});

		expect(rendered).toMatchObject({
			kind: 'alert.test',
			severity: 'info',
			audience: 'broadcast',
			title: 'Test alert for Forecasts',
			data: { destination_id: destinationId, test_id: 'test-request-1' },
			dedupe_key: 'alert.test:alert-0123456789abcdef:test-request-1:broadcast',
		});
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

	it('preserves the original error when one adapter fails', async () => {
		const failure = Object.assign(new Error('offline'), { code: 'ECONNRESET' });
		const failed: Notifier = {
			deliver: async () => {
				throw failure;
			},
		};

		await expect(
			fanOutNotifier([{ name: 'smtp', notifier: failed }]).deliver(notification),
		).rejects.toBe(failure);
	});

	it('uses the failure message when one adapter rejects without a reason', () => {
		expect(() =>
			reduceNotificationDeliveryResults(
				[{ status: 'rejected', reason: undefined }],
				'No notification adapter delivered',
			),
		).toThrow('No notification adapter delivered');
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
		).rejects.toThrow('offline');
	});

	it('filters disabled kinds', async () => {
		const target: Notifier = { deliver: vi.fn(async () => 'delivered' as const) };
		const filtered = filterNotifier(target, new Set(['session.takeover']));
		await expect(filtered.deliver(notification)).resolves.toBe('skipped');
		expect(target.deliver).not.toHaveBeenCalled();
	});

	it('disposes every adapter through fan-out and filters', async () => {
		const first = {
			deliver: vi.fn(async () => 'skipped' as const),
			[Symbol.asyncDispose]: vi.fn(async () => {}),
		};
		const second = { deliver: vi.fn(async () => 'skipped' as const), close: vi.fn() };
		const notifier = fanOutNotifier([
			{ name: 'smtp', notifier: filterNotifier(first, new Set()) },
			{ name: 'webhook', notifier: second },
		]);

		await notifier[Symbol.asyncDispose]?.();

		expect(first[Symbol.asyncDispose]).toHaveBeenCalledOnce();
		expect(second.close).toHaveBeenCalledOnce();
	});

	it('waits for every adapter disposal before reporting a failure', async () => {
		let finishSecond: (() => void) | undefined;
		const firstFailure = new Error('first close failed');
		const first = {
			deliver: vi.fn(async () => 'skipped' as const),
			close: vi.fn(async () => {
				throw firstFailure;
			}),
		};
		const second = {
			deliver: vi.fn(async () => 'skipped' as const),
			close: vi.fn(() => new Promise<void>((resolve) => (finishSecond = resolve))),
		};
		const notifier = fanOutNotifier([
			{ name: 'first', notifier: first },
			{ name: 'second', notifier: second },
		]);

		let settled = false;
		const disposing = Promise.resolve(notifier.close?.()).finally(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		finishSecond?.();
		await expect(disposing).rejects.toBe(firstFailure);
	});

	it('reports a meaningful error when adapter disposal rejects without a reason', async () => {
		const notifier = fanOutNotifier([
			{
				name: 'broken',
				notifier: {
					deliver: vi.fn(async () => 'skipped' as const),
					// oxlint-disable-next-line typescript/prefer-promise-reject-errors -- verifies an untyped JavaScript rejection boundary
					close: vi.fn(() => Promise.reject()),
				},
			},
		]);

		await expect(notifier.close?.()).rejects.toThrow('Notification adapter disposal failed');
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
		['data for another kind', { data: { takeover_id: 'takeover-1' } }],
	])('rejects %s', (_label, replacement) => {
		expect(() => NotificationSchema.parse({ ...notification, ...replacement })).toThrow();
	});

	it('rejects an audience unsupported by a kind', () => {
		const [testAlert] = notificationRouter.render({
			kind: 'alert.test',
			project,
			destinationId: 'alert-0123456789abcdef' as never,
			actor: { id: uid('owner_notify'), email: 'owner@example.com' },
			testId: 'test-request-1',
		});
		expect(() => NotificationSchema.parse({ ...testAlert, audience: 'personal' })).toThrow();
	});

	it('rejects malformed branded IDs in project-alert payloads', () => {
		const [appAlert] = notificationRouter.render({
			kind: 'app.unavailable',
			project,
			notebookId: ids().notebook,
			notebookTitle: 'Revenue',
			sessionId: ids().session,
			startedByUserId: uid('app_starter'),
			errorCode: 'SANDBOX_DISAPPEARED',
		});
		const [testAlert] = notificationRouter.render({
			kind: 'alert.test',
			project,
			destinationId: 'alert-0123456789abcdef' as never,
			actor: { id: uid('owner_notify'), email: 'owner@example.com' },
			testId: 'test-request-1',
		});

		expect(() =>
			NotificationSchema.parse({
				...appAlert,
				data: { ...appAlert?.data, session_id: 'not-a-session' },
			}),
		).toThrow();
		expect(() =>
			NotificationSchema.parse({
				...testAlert,
				data: { ...testAlert?.data, destination_id: 'not-a-destination' },
			}),
		).toThrow();
	});
});
