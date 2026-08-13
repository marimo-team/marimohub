import type { Metrics } from './metrics';
import { noopMetrics } from './metrics';
import type { Notification } from '../notifications';

export type NotificationDeliveryOutcome = 'delivered' | 'partial' | 'skipped';

export interface Notifier {
	/**
	 * Return `skipped` only when the adapter has no delivery target. Composite
	 * notifiers return `partial` when some targets fail. Throw when no target
	 * delivers. Receivers must use `dedupe_key` as the idempotency key.
	 */
	deliver(notification: Notification): Promise<NotificationDeliveryOutcome>;
	[Symbol.asyncDispose]?(): PromiseLike<void>;
	close?(): Promise<void> | void;
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

export async function disposeNotifier(notifier: Notifier): Promise<void> {
	const dispose = notifier[Symbol.asyncDispose];
	if (dispose) await dispose.call(notifier);
	else await notifier.close?.();
}

export function reduceNotificationDeliveryResults(
	results: readonly PromiseSettledResult<NotificationDeliveryOutcome>[],
	failureMessage: string,
): NotificationDeliveryOutcome {
	const failures = results.filter((result) => result.status === 'rejected');
	const outcomes = results
		.filter((result) => result.status === 'fulfilled')
		.map((result) => result.value);
	if (outcomes.some((outcome) => outcome === 'delivered' || outcome === 'partial')) {
		return failures.length > 0 || outcomes.includes('partial') ? 'partial' : 'delivered';
	}
	if (failures.length > 0) {
		if (failures.length === 1) {
			const reason = failures[0].reason;
			throw reason === undefined ? new Error(failureMessage) : reason;
		}
		throw new AggregateError(
			failures.map((result) => result.reason),
			failureMessage,
		);
	}
	return 'skipped';
}

export function fanOutNotifier(targets: NamedNotifier[], metrics: Metrics = noopMetrics): Notifier {
	if (targets.length === 0) return noopNotifier;
	const dispose = async (): Promise<void> => {
		const results = await Promise.allSettled(
			targets.map(({ notifier }) => disposeNotifier(notifier)),
		);
		const failures = results.filter((result) => result.status === 'rejected');
		if (failures.length === 1) throw failures[0].reason;
		if (failures.length > 1) {
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				'Notification adapter disposal failed',
			);
		}
	};
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
			return reduceNotificationDeliveryResults(results, 'No notification adapter delivered');
		},
		close: dispose,
		[Symbol.asyncDispose]: dispose,
	};
}

export function filterNotifier(notifier: Notifier, enabledKinds: ReadonlySet<string>): Notifier {
	const dispose = () => disposeNotifier(notifier);
	return {
		async deliver(notification) {
			if (!enabledKinds.has(notification.kind)) return 'skipped';
			return notifier.deliver(notification);
		},
		close: dispose,
		[Symbol.asyncDispose]: dispose,
	};
}
