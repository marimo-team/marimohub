import type { AlertDestinationId, ProjectId } from '../ids';
import type { Notification, ProjectAlertKind } from '../notifications';
import type { NotificationDeliveryOutcome } from './notifier';
import type { ProjectAlertDestination } from '../services/notifications/ProjectAlertStore';

export interface ProjectAlertDispatcher {
	deliver(
		projectId: ProjectId,
		kind: ProjectAlertKind,
		notification: Notification,
	): Promise<NotificationDeliveryOutcome>;
	test(
		projectId: ProjectId,
		destinationId: AlertDestinationId,
		expectedVersion: string | undefined,
		notification: Notification,
	): Promise<ProjectAlertDestination>;
}
