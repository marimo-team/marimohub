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

type RenderNotifications = () =>
	| Notification
	| readonly Notification[]
	| Promise<Notification | readonly Notification[]>;

function scheduleDelivery(
	deps: ApiDeps,
	kind: NotificationKind,
	fields: Record<string, unknown>,
	makeNotification: RenderNotifications,
	events: { partial: string; failed: string },
	deliver: (notifications: readonly Notification[]) => Promise<NotificationDeliveryOutcome>,
): void {
	const delivery = Promise.resolve()
		.then(makeNotification)
		.then((rendered) =>
			deliver((Array.isArray(rendered) ? rendered : [rendered]) as readonly Notification[]),
		)
		.then((outcome) => {
			if (outcome === 'partial') {
				logEvent({
					...fields,
					level: 'warn',
					event: events.partial,
					notification_kind: kind,
				});
			}
		})
		.catch((error: unknown) => {
			logEvent({
				...fields,
				level: 'error',
				event: events.failed,
				notification_kind: kind,
				error: errorMetadata(error),
			});
		});
	deps.backgroundTasks?.defer(delivery);
}

export function scheduleNotification(
	deps: ApiDeps,
	kind: NotificationKind,
	fields: Record<string, unknown>,
	makeNotification: RenderNotifications,
): void {
	scheduleDelivery(
		deps,
		kind,
		fields,
		makeNotification,
		{ partial: 'notification_delivery_partial', failed: 'notification_delivery_failed' },
		async (notifications) => {
			if (notifications.length === 0) return 'skipped';
			const results = await Promise.allSettled(
				notifications.map((notification) => (deps.notifier ?? noopNotifier).deliver(notification)),
			);
			return reduceNotificationDeliveryResults(results, 'No notification variant delivered');
		},
	);
}

export function scheduleProjectAlert(
	deps: ApiDeps,
	projectId: ProjectId,
	kind: ProjectAlertKind,
	fields: Record<string, unknown>,
	makeNotification: RenderNotifications,
): void {
	const projectAlerts = deps.projectAlerts;
	if (!projectAlerts) return;
	scheduleDelivery(
		deps,
		kind,
		fields,
		makeNotification,
		{
			partial: 'project_alert_delivery_partial',
			failed: 'project_alert_delivery_failed',
		},
		async (notifications) => {
			const notification = notifications.find(
				(candidate) => candidate.kind === kind && candidate.audience === 'broadcast',
			);
			if (!notification) return 'skipped';
			return projectAlerts.dispatcher.deliver(projectId, kind, notification);
		},
	);
}
