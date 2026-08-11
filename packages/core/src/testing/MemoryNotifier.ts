import type { Notification, Notifier } from '..';

export class MemoryNotifier implements Notifier {
	readonly deliveries: Notification[] = [];
	attempts = 0;
	private remainingFailures = 0;

	failNext(count = 1): void {
		this.remainingFailures += count;
	}

	async deliver(notification: Notification): Promise<'delivered'> {
		this.attempts += 1;
		if (this.remainingFailures > 0) {
			this.remainingFailures -= 1;
			throw new Error('MemoryNotifier delivery failed');
		}
		this.deliveries.push(structuredClone(notification));
		return 'delivered';
	}
}
