import { noopNotifier } from '@marimo-hub/core';
import type { Notification, NotificationDeliveryOutcome, NotificationKind } from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { errorMetadata, logEvent } from './log';

export function scheduleNotification(
	deps: ApiDeps,
	kind: NotificationKind,
	fields: Record<string, unknown>,
	makeNotification: () =>
		| Notification
		| readonly Notification[]
		| Promise<Notification | readonly Notification[]>,
): void {
	const delivery = Promise.resolve()
		.then(makeNotification)
		.then(async (rendered): Promise<NotificationDeliveryOutcome> => {
			const notifications = (
				Array.isArray(rendered) ? rendered : [rendered]
			) as readonly Notification[];
			if (notifications.length === 0) return 'skipped';
			const results = await Promise.allSettled(
				notifications.map((notification) => (deps.notifier ?? noopNotifier).deliver(notification)),
			);
			const failures = results.filter((result) => result.status === 'rejected');
			const outcomes = results
				.filter((result) => result.status === 'fulfilled')
				.map((result) => result.value);
			if (outcomes.some((outcome) => outcome === 'delivered' || outcome === 'partial')) {
				return failures.length > 0 || outcomes.includes('partial') ? 'partial' : 'delivered';
			}
			if (failures.length > 0) {
				if (failures.length === 1) throw failures[0]?.reason;
				throw new AggregateError(
					failures.map((result) => result.reason),
					'No notification variant delivered',
				);
			}
			return 'skipped';
		})
		.then((outcome) => {
			if (outcome === 'partial') {
				logEvent({
					...fields,
					level: 'warn',
					event: 'notification_delivery_partial',
					notification_kind: kind,
				});
			}
		})
		.catch((error: unknown) => {
			logEvent({
				...fields,
				level: 'error',
				event: 'notification_delivery_failed',
				notification_kind: kind,
				error: errorMetadata(error),
			});
		});
	deps.backgroundTasks?.defer(delivery);
}
