import { noopNotifier, reduceNotificationDeliveryResults } from '@marimo-hub/core';
import type {
	Notification,
	NotificationDeliveryOutcome,
	NotificationKind,
	ProjectAlertKind,
	ProjectId,
} from '@marimo-hub/core';
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
			return reduceNotificationDeliveryResults(results, 'No notification variant delivered');
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

export function scheduleProjectAlert(
	deps: ApiDeps,
	projectId: ProjectId,
	kind: ProjectAlertKind,
	fields: Record<string, unknown>,
	makeNotification: () =>
		| Notification
		| readonly Notification[]
		| Promise<Notification | readonly Notification[]>,
): void {
	if (!deps.projectAlerts) return;
	const delivery = Promise.resolve()
		.then(makeNotification)
		.then(async (rendered): Promise<NotificationDeliveryOutcome> => {
			const notifications = (
				Array.isArray(rendered) ? rendered : [rendered]
			) as readonly Notification[];
			const notification = notifications.find(
				(candidate) => candidate.kind === kind && candidate.audience === 'broadcast',
			);
			if (!notification) return 'skipped';
			return deps.projectAlerts!.dispatcher.deliver(projectId, kind, notification);
		})
		.then((outcome) => {
			if (outcome === 'partial') {
				logEvent({
					...fields,
					level: 'warn',
					event: 'project_alert_delivery_partial',
					notification_kind: kind,
				});
			}
		})
		.catch((error: unknown) => {
			logEvent({
				...fields,
				level: 'error',
				event: 'project_alert_delivery_failed',
				notification_kind: kind,
				error: errorMetadata(error),
			});
		});
	deps.backgroundTasks?.defer(delivery);
}
