import {
	MAX_PROJECT_ALERT_DESTINATIONS,
	NotFoundError,
	noopMetrics,
	ProjectAlertStore,
	reduceNotificationDeliveryResults,
	UnavailableError,
	assertVersionMatch,
} from '@marimo-hub/core';
import type {
	AlertDestinationId,
	Bucket,
	IntegrationProbe,
	Metrics,
	Notification,
	NotificationDeliveryOutcome,
	ProjectAlertDestination,
	ProjectAlertDispatcher,
	ProjectAlertKind,
	ProjectId,
	ResolvedProjectAlertDestination,
} from '@marimo-hub/core';
import { SlackNotifier } from '@marimo-hub/notify-slack';
import { WebhookNotifier } from '@marimo-hub/notify-webhook';
import { ConfigError } from './errors';
import type { Env } from './env';
import { readFolded } from './env';
import { createGuardedProbe } from './integrationProbe';
import { makeSecretSources } from './secrets';

const DOCS = 'docs/project-alerts.md';

export interface ProjectAlertsConfig {
	store: ProjectAlertStore;
	dispatcher: ProjectAlertDispatcher;
	maxDestinations: number;
}

export function projectAlertsEnabled(env: Env): boolean {
	const value = readFolded(env, 'MARIMOHUB_PROJECT_ALERTS');
	if (value === undefined || value === 'off' || value === 'false') return false;
	if (value === 'on' || value === 'true') return true;
	throw new ConfigError(
		`Invalid MARIMOHUB_PROJECT_ALERTS: ${env.MARIMOHUB_PROJECT_ALERTS} (expected on or off)`,
		{ variable: 'MARIMOHUB_PROJECT_ALERTS', docs: DOCS },
	);
}

export function makeProjectAlerts(
	env: Env,
	bucket: Bucket,
	metrics: Metrics = noopMetrics,
): ProjectAlertsConfig | undefined {
	if (!projectAlertsEnabled(env)) return undefined;
	const codec = makeSecretSources(env).codec;
	if (!codec) {
		throw new ConfigError(
			'MARIMOHUB_PROJECT_ALERTS requires MARIMOHUB_SECRETS_KEK for encrypted destination storage',
			{
				variable: 'MARIMOHUB_SECRETS_KEK',
				docs: DOCS,
				remediation: 'Generate a 32-byte key, configure it on every replica, and restart.',
			},
		);
	}
	const store = new ProjectAlertStore(bucket, codec);
	return {
		store,
		dispatcher: new NodeProjectAlertDispatcher(store, metrics),
		maxDestinations: MAX_PROJECT_ALERT_DESTINATIONS,
	};
}

export class NodeProjectAlertDispatcher implements ProjectAlertDispatcher {
	private readonly probe: IntegrationProbe;

	constructor(
		private readonly store: ProjectAlertStore,
		private readonly metrics: Metrics,
		probe?: IntegrationProbe,
	) {
		this.probe =
			probe ??
			createGuardedProbe({
				allowPrivate: false,
				timeoutMs: 10_000,
				maxResponseBytes: 16 * 1024,
				maxProbesPerMinute: 10_000,
			});
	}

	async deliver(
		projectId: ProjectId,
		kind: ProjectAlertKind,
		notification: Notification,
	): Promise<NotificationDeliveryOutcome> {
		if (notification.kind !== kind || notification.audience !== 'broadcast') {
			throw new Error('Project alerts require a matching broadcast notification');
		}
		const destinations = await this.store.resolve(projectId, { kind, requireEnabled: true });
		if (destinations.length === 0) {
			this.metrics.increment('project_alert.skipped', 1, { kind });
			return 'skipped';
		}
		const results = await Promise.allSettled(
			destinations.map((destination) => this.deliverTo(destination, notification)),
		);
		return reduceNotificationDeliveryResults(results, 'No project alert destination delivered');
	}

	async test(
		projectId: ProjectId,
		destinationId: AlertDestinationId,
		expectedVersion: string | undefined,
		notification: Notification,
	): Promise<ProjectAlertDestination> {
		const [destination] = await this.store.resolve(projectId, { id: destinationId });
		if (!destination) {
			throw new NotFoundError('Alert destination not found');
		}
		assertVersionMatch(destination.updated_at, expectedVersion);
		try {
			await this.deliverTo(destination, notification);
		} catch {
			throw new UnavailableError('Alert destination test failed');
		}
		return this.store.markVerified(projectId, destinationId, destination.updated_at);
	}

	private async deliverTo(
		destination: ResolvedProjectAlertDestination,
		notification: Notification,
	): Promise<NotificationDeliveryOutcome> {
		try {
			const outcome =
				destination.type === 'slack'
					? await new SlackNotifier({
							webhookUrl: destination.webhook_url,
							fetcher: async (url, options) => {
								await this.request(url, {
									method: options.method,
									headers: { 'content-type': 'application/json' },
									body: JSON.stringify(options.body),
								});
							},
						}).deliver(notification)
					: await new WebhookNotifier({
							url: destination.url,
							secret: destination.signing_secret,
							fetcher: async (url, options) => {
								let lastError: unknown;
								for (let attempt = 0; attempt <= options.retry; attempt++) {
									try {
										await this.request(url, options);
										return;
									} catch (error) {
										lastError = error;
									}
								}
								throw lastError;
							},
						}).deliver(notification);
			this.metrics.increment(`project_alert.${outcome}`, 1, {
				adapter: destination.type,
				kind: notification.kind,
			});
			return outcome;
		} catch (error) {
			this.metrics.increment('project_alert.deliver_failed', 1, {
				adapter: destination.type,
				kind: notification.kind,
			});
			throw error;
		}
	}

	private async request(
		url: string,
		options: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
	): Promise<void> {
		const response = await this.probe.fetch(url, options);
		if (!response.ok) throw new Error(`Alert destination returned HTTP ${response.status}`);
	}
}
