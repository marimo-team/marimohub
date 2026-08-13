import {
	filterNotifier,
	fanOutNotifier,
	GLOBAL_NOTIFICATION_KINDS,
	noopMetrics,
	noopNotifier,
} from '@marimo-hub/core';
import type { Metrics, NamedNotifier, Notifier, ProbeRequestInit } from '@marimo-hub/core';
import { SlackNotifier } from '@marimo-hub/notify-slack';
import { SmtpNotifier } from '@marimo-hub/notify-smtp';
import { WebhookNotifier } from '@marimo-hub/notify-webhook';
import { ConfigError } from './errors';
import type { Env } from './env';
import { parseList, required } from './env';
import { createGuardedProbe } from './integrationProbe';
import type { ProbeTransport } from './integrationProbe';

export const NOTIFICATION_BACKENDS = ['smtp', 'slack', 'webhook'] as const;
export type NotificationBackend = (typeof NOTIFICATION_BACKENDS)[number];

export function notificationBackends(env: Env): NotificationBackend[] {
	const values =
		parseList(env.MARIMOHUB_NOTIFY_BACKENDS)?.map((value) => value.toLowerCase()) ?? [];
	const unsupported = values.filter(
		(value): value is string => !NOTIFICATION_BACKENDS.includes(value as NotificationBackend),
	);
	if (unsupported.length > 0) {
		throw new ConfigError(
			`Invalid MARIMOHUB_NOTIFY_BACKENDS: ${unsupported.join(', ')} ` +
				`(expected ${NOTIFICATION_BACKENDS.join(', ')})`,
			{ variable: 'MARIMOHUB_NOTIFY_BACKENDS', docs: 'docs/notifications.md' },
		);
	}
	return [...new Set(values)] as NotificationBackend[];
}

const BACKEND_KIND_VARIABLES: Record<NotificationBackend, string> = {
	smtp: 'MARIMOHUB_NOTIFY_SMTP_KINDS',
	slack: 'MARIMOHUB_NOTIFY_SLACK_KINDS',
	webhook: 'MARIMOHUB_NOTIFY_WEBHOOK_KINDS',
};

function parseKinds(env: Env, variable: string, fallback: ReadonlySet<string>): Set<string> {
	const configured = parseList(env[variable]);
	if (!configured) return new Set(fallback);
	if (configured.length === 1 && configured[0]?.toLowerCase() === 'none') return new Set();
	const known = new Set<string>(GLOBAL_NOTIFICATION_KINDS);
	const unsupported = configured.filter((kind) => !known.has(kind));
	if (unsupported.length > 0) {
		throw new ConfigError(
			`Invalid ${variable}: ${unsupported.join(', ')} ` +
				`(expected ${GLOBAL_NOTIFICATION_KINDS.join(', ')}, or none)`,
			{ variable, docs: 'docs/notifications.md' },
		);
	}
	return new Set(configured);
}

export function notificationKindsForBackend(env: Env, backend: NotificationBackend): Set<string> {
	const globalKinds = parseKinds(env, 'MARIMOHUB_NOTIFY_KINDS', new Set(GLOBAL_NOTIFICATION_KINDS));
	if (globalKinds.size === 0) return globalKinds;
	return parseKinds(env, BACKEND_KIND_VARIABLES[backend], globalKinds);
}

class NotificationHttpError extends Error {
	constructor(readonly status: number) {
		super(`Notification delivery returned HTTP ${status}`);
		this.name = 'NotificationHttpError';
	}
}

function retryableNotificationError(error: unknown): boolean {
	return (
		!(error instanceof NotificationHttpError) ||
		error.status === 408 ||
		error.status === 429 ||
		error.status >= 500
	);
}

export function makeNotifier(env: Env, metrics?: Metrics, transport?: ProbeTransport): Notifier {
	// Deliveries are notification volume, not connection tests, so lift the probe
	// default of 30/minute out of the way (projectAlerts.ts does the same).
	const guardedProbe = createGuardedProbe({
		timeoutMs: 10_000,
		maxResponseBytes: 1024,
		maxProbesPerMinute: 10_000,
		transport,
	});
	const send = async (
		url: string,
		options: ProbeRequestInit,
		retry: number,
	): Promise<{ ok: boolean }> => {
		let lastError: unknown;
		for (let attempt = 0; attempt <= retry; attempt++) {
			try {
				const response = await guardedProbe.fetch(url, options);
				if (!response.ok) throw new NotificationHttpError(response.status);
				return { ok: true };
			} catch (error) {
				lastError = error;
				if (attempt === retry || !retryableNotificationError(error)) throw error;
			}
		}
		throw lastError;
	};
	const targets: NamedNotifier[] = notificationBackends(env).map((backend) => {
		let notifier: Notifier;
		switch (backend) {
			case 'smtp':
				notifier = new SmtpNotifier({
					url: required(env, 'MARIMOHUB_NOTIFY_SMTP_URL'),
					from: required(env, 'MARIMOHUB_NOTIFY_SMTP_FROM'),
					adminTo: parseList(env.MARIMOHUB_NOTIFY_SMTP_ADMIN_TO),
				});
				break;
			case 'slack':
				notifier = new SlackNotifier({
					webhookUrl: required(env, 'MARIMOHUB_NOTIFY_SLACK_WEBHOOK_URL'),
					fetcher: (url, request) =>
						send(
							url,
							{
								method: request.method,
								headers: { 'content-type': 'application/json' },
								body: JSON.stringify(request.body),
							},
							request.retry,
						),
				});
				break;
			case 'webhook':
				notifier = new WebhookNotifier({
					url: required(env, 'MARIMOHUB_NOTIFY_WEBHOOK_URL'),
					secret: required(env, 'MARIMOHUB_NOTIFY_WEBHOOK_SECRET'),
					fetcher: (url, request) =>
						send(
							url,
							{ method: request.method, headers: request.headers, body: request.body },
							request.retry,
						),
				});
				break;
		}
		return {
			name: backend,
			notifier: filterNotifier(notifier, notificationKindsForBackend(env, backend)),
		};
	});
	if (targets.length === 0) return noopNotifier;
	return fanOutNotifier(targets, metrics ?? noopMetrics);
}
