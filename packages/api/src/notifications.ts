import { noopNotifier } from '@marimo-hub/core';
import type { Notification } from '@marimo-hub/core';
import type { ApiDeps } from './context';
import { errorMetadata, logEvent } from './log';

export function scheduleNotification(
	deps: ApiDeps,
	kind: string,
	fields: Record<string, unknown>,
	makeNotification: () => Notification | Promise<Notification>,
): void {
	queueMicrotask(() => {
		Promise.resolve()
			.then(makeNotification)
			.then((notification) => (deps.notifier ?? noopNotifier).deliver(notification))
			.catch((error: unknown) => {
				logEvent({
					...fields,
					level: 'error',
					event: 'notification_delivery_failed',
					notification_kind: kind,
					error: errorMetadata(error),
				});
			});
	});
}
