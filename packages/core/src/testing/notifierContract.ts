import { afterEach, describe, expect, it } from 'vitest';
import { disposeNotifier } from '../ports/notifier';
import type { NotificationDeliveryOutcome, Notifier } from '../ports/notifier';
import { NotificationSchema, notificationRouter } from '../notifications';
import { UserId } from '../ids';
import { BROADCAST_NOTIFICATION_FIXTURE, NOTIFICATION_FIXTURE } from './notificationFixtures';

export const CONTRACT_SEED = Object.freeze({
	personal: NOTIFICATION_FIXTURE,
	broadcast: BROADCAST_NOTIFICATION_FIXTURE,
});

export function notifierContract(
	name: string,
	makeNotifier: () => Notifier,
	expected: Readonly<Record<keyof typeof CONTRACT_SEED, NotificationDeliveryOutcome>>,
): void {
	describe(`Notifier contract: ${name}`, () => {
		let notifier: Notifier | undefined;

		afterEach(async () => {
			const current = notifier;
			notifier = undefined;
			if (current) await disposeNotifier(current);
		});

		it('delivers support reports through the broadcast destination', async () => {
			const [notification] = notificationRouter.render({
				kind: 'support.request',
				message: 'The app did not start',
				requestId: 'support-contract',
				diagnostics: {
					reporter: { id: UserId.parse('reporter'), email: 'reporter@example.com' },
					page_url: 'https://hub.example.com/apps',
					hub_version: '1.2.3',
					timestamp: '2026-11-02T00:00:00.000Z',
					client: { user_agent: 'browser', viewport: { width: 1024, height: 768 } },
				},
			});
			notifier = makeNotifier();
			await expect(notifier.deliver(notification)).resolves.toBe(expected.broadcast);
		});

		it.each(Object.entries(CONTRACT_SEED))(
			'delivers a schema-valid %s seed with the documented outcome',
			async (audience, notification) => {
				expect(NotificationSchema.safeParse(notification).success).toBe(true);
				const snapshot = structuredClone(notification);
				notifier = makeNotifier();
				await expect(notifier.deliver(notification)).resolves.toBe(
					expected[audience as keyof typeof CONTRACT_SEED],
				);
				expect(notification).toEqual(snapshot);
			},
		);
	});
}
