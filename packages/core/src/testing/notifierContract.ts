import { describe, expect, it } from 'vitest';
import type { NotificationDeliveryOutcome, Notifier } from '../ports/notifier';
import { NotificationSchema } from '../notifications';
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
		it.each(Object.entries(CONTRACT_SEED))(
			'delivers a schema-valid %s seed with the documented outcome',
			async (audience, notification) => {
				expect(NotificationSchema.safeParse(notification).success).toBe(true);
				const snapshot = structuredClone(notification);
				await expect(makeNotifier().deliver(notification)).resolves.toBe(
					expected[audience as keyof typeof CONTRACT_SEED],
				);
				expect(notification).toEqual(snapshot);
			},
		);
	});
}
