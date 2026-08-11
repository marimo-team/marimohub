import type { Metrics } from './metrics';
import { noopMetrics } from './metrics';
import type { Notification } from '../schema';

export type NotificationDeliveryOutcome = 'delivered' | 'skipped';

export interface Notifier {
	/**
	 * Return `skipped` only when the adapter has no delivery target. Throw when an
	 * attempted delivery fails. Receivers must use `dedupe_key` as the idempotency key.
	 */
	deliver(notification: Notification): Promise<NotificationDeliveryOutcome>;
}

export const noopNotifier: Notifier = {
	async deliver() {
		return 'skipped';
	},
};

export interface NamedNotifier {
	name: string;
	notifier: Notifier;
}

export function fanOutNotifier(targets: NamedNotifier[], metrics: Metrics = noopMetrics): Notifier {
	if (targets.length === 0) return noopNotifier;
	return {
		async deliver(notification) {
			const results = await Promise.allSettled(
				targets.map(async ({ name, notifier }) => {
					try {
						const outcome = await notifier.deliver(notification);
						metrics.increment(`notify.${outcome}`, 1, {
							adapter: name,
							kind: notification.kind,
						});
						return outcome;
					} catch (error) {
						metrics.increment('notify.deliver_failed', 1, {
							adapter: name,
							kind: notification.kind,
						});
						throw error;
					}
				}),
			);
			if (results.some((result) => result.status === 'fulfilled' && result.value === 'delivered')) {
				return 'delivered';
			}
			const failures = results.filter((result) => result.status === 'rejected');
			if (failures.length > 0) {
				throw new AggregateError(
					failures.map((result) => result.reason),
					'No notification adapter delivered',
				);
			}
			return 'skipped';
		},
	};
}

export function filterNotifier(notifier: Notifier, enabledKinds: ReadonlySet<string>): Notifier {
	return {
		async deliver(notification) {
			if (!enabledKinds.has(notification.kind)) return 'skipped';
			return notifier.deliver(notification);
		},
	};
}
