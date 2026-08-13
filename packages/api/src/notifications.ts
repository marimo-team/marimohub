import {
	createSlidingWindowBudget,
	noopNotifier,
	reduceNotificationDeliveryResults,
	ResourceExhaustedError,
} from '@marimo-hub/core';
import type {
	Notification,
	NotificationDeliveryOutcome,
	NotificationKind,
	ProjectAlertKind,
	ProjectId,
	SlidingWindowBudget,
	UserId,
} from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { errorMetadata, logEvent } from './log';

type RenderNotifications = () =>
	| Notification
	| readonly Notification[]
	| Promise<Notification | readonly Notification[]>;

interface NotificationMutationBudgets {
	actor: SlidingWindowBudget<UserId>;
	recipient: SlidingWindowBudget<string>;
}

const mutationBudgets = new WeakMap<ApiDeps, NotificationMutationBudgets>();

export function assertNotificationMutationAllowed(
	deps: ApiDeps,
	actor: UserId,
	recipient?: string,
): void {
	if ((!deps.notifier || deps.notifier === noopNotifier) && !deps.projectAlerts) return;
	let budgets = mutationBudgets.get(deps);
	if (!budgets) {
		budgets = {
			actor: createSlidingWindowBudget({ limit: 20, windowMs: 60_000 }),
			recipient: createSlidingWindowBudget({ limit: 5, windowMs: 10 * 60_000 }),
		};
		mutationBudgets.set(deps, budgets);
	}
	if (!budgets.actor.consume(actor)) {
		throw new ResourceExhaustedError('Too many notification-triggering changes; try again later.');
	}
	if (recipient && !budgets.recipient.consume(recipient.toLowerCase())) {
		throw new ResourceExhaustedError(
			'Too many notifications were requested for this recipient; try again later.',
		);
	}
}

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
