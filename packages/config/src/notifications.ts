import {
	filterNotifier,
	fanOutNotifier,
	noopMetrics,
	noopNotifier,
	SYNC_NOTIFICATION_KINDS,
} from '@marimo-hub/core';
import type { Metrics, NamedNotifier, Notifier } from '@marimo-hub/core';
import { SlackNotifier } from '@marimo-hub/notify-slack';
import { SmtpNotifier } from '@marimo-hub/notify-smtp';
import { WebhookNotifier } from '@marimo-hub/notify-webhook';
import { ConfigError } from './errors';
import type { Env } from './env';
import { parseList, required } from './env';

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

function enabledKinds(env: Env): Set<string> {
	const configured = parseList(env.MARIMOHUB_NOTIFY_KINDS);
	if (!configured) return new Set(SYNC_NOTIFICATION_KINDS);
	const known = new Set<string>(SYNC_NOTIFICATION_KINDS);
	const unsupported = configured.filter((kind) => !known.has(kind));
	if (unsupported.length > 0) {
		throw new ConfigError(
			`Invalid MARIMOHUB_NOTIFY_KINDS: ${unsupported.join(', ')} ` +
				`(expected ${SYNC_NOTIFICATION_KINDS.join(', ')})`,
			{ variable: 'MARIMOHUB_NOTIFY_KINDS', docs: 'docs/notifications.md' },
		);
	}
	return new Set(configured);
}

export function makeNotifier(env: Env, metrics?: Metrics): Notifier {
	const targets: NamedNotifier[] = notificationBackends(env).map((backend) => {
		switch (backend) {
			case 'smtp':
				return {
					name: backend,
					notifier: new SmtpNotifier({
						url: required(env, 'MARIMOHUB_NOTIFY_SMTP_URL'),
						from: required(env, 'MARIMOHUB_NOTIFY_SMTP_FROM'),
						adminTo: parseList(env.MARIMOHUB_NOTIFY_SMTP_ADMIN_TO),
					}),
				};
			case 'slack':
				return {
					name: backend,
					notifier: new SlackNotifier({
						webhookUrl: required(env, 'MARIMOHUB_NOTIFY_SLACK_WEBHOOK_URL'),
					}),
				};
			case 'webhook':
				return {
					name: backend,
					notifier: new WebhookNotifier({
						url: required(env, 'MARIMOHUB_NOTIFY_WEBHOOK_URL'),
						secret: required(env, 'MARIMOHUB_NOTIFY_WEBHOOK_SECRET'),
					}),
				};
		}
	});
	if (targets.length === 0) return noopNotifier;
	return filterNotifier(fanOutNotifier(targets, metrics ?? noopMetrics), enabledKinds(env));
}
