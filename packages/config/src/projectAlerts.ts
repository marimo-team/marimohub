import {
	MAX_PROJECT_ALERT_DESTINATIONS,
	NotFoundError,
	noopMetrics,
	ProjectAlertStore,
	createSlidingWindowBudget,
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
	SlidingWindowBudget,
} from '@marimo-hub/core';
import { SlackNotifier } from '@marimo-hub/notify-slack';
import { WebhookNotifier } from '@marimo-hub/notify-webhook';
import { ConfigError } from './errors';
import type { Env } from './env';
import { readFolded } from './env';
import { createGuardedProbe } from './integrationProbe';
import { makeSecretSources } from './secrets';

const DOCS = 'docs/project-alerts.md';
const MAX_PROJECT_ALERT_EVENTS_PER_MINUTE = 100;

class AlertHttpError extends Error {
	constructor(readonly status: number) {
		super(`Alert destination returned HTTP ${status}`);
		this.name = 'AlertHttpError';
	}
}

function retryableAlertError(error: unknown): boolean {
	return (
		!(error instanceof AlertHttpError) ||
		error.status === 408 ||
		error.status === 429 ||
		error.status >= 500
	);
}

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
	private readonly deliveryBudget: SlidingWindowBudget<ProjectId>;

	constructor(
		private readonly store: ProjectAlertStore,
		private readonly metrics: Metrics,
		probe?: IntegrationProbe,
		deliveryBudget?: SlidingWindowBudget<ProjectId>,
	) {
		this.probe =
			probe ??
			createGuardedProbe({
				allowPrivate: false,
				timeoutMs: 10_000,
				maxResponseBytes: 16 * 1024,
				maxProbesPerMinute: 10_000,
			});
		this.deliveryBudget =
			deliveryBudget ??
			createSlidingWindowBudget({
				limit: MAX_PROJECT_ALERT_EVENTS_PER_MINUTE,
				windowMs: 60_000,
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
		const destinations = (await this.store.list(projectId)).filter(
			(destination) =>
				destination.enabled && destination.verified_at !== null && destination.kinds.includes(kind),
		);
		if (destinations.length === 0) {
			this.metrics.increment('project_alert.skipped', 1, { kind });
			return 'skipped';
		}
		if (!this.deliveryBudget.consume(projectId)) {
			this.metrics.increment('project_alert.rate_limited', 1, { kind });
			return 'skipped';
		}
		const results = await Promise.allSettled(
			destinations.map(async (configured) => {
				let destination: ResolvedProjectAlertDestination | undefined;
				try {
					[destination] = await this.store.resolve(projectId, {
						id: configured.id,
						kind,
						requireEnabled: true,
					});
				} catch (error) {
					this.metrics.increment('project_alert.deliver_failed', 1, {
						adapter: configured.type,
						kind: notification.kind,
					});
					throw error;
				}
				return destination ? this.deliverTo(destination, notification) : 'skipped';
			}),
		);
		const outcome = reduceNotificationDeliveryResults(
			results,
			'No project alert destination delivered',
		);
		if (outcome === 'skipped') {
			this.metrics.increment('project_alert.skipped', 1, { kind });
		}
		return outcome;
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
										if (attempt === options.retry || !retryableAlertError(error)) throw error;
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
		if (!response.ok) throw new AlertHttpError(response.status);
	}
}
