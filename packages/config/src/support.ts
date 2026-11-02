import { SupportModeSchema } from '@marimo-hub/core/support';
import type { SupportMode } from '@marimo-hub/core/support';
import { ConfigError } from './errors';
import type { Env } from './env';
import { parseEnumOr, parseList } from './env';
import { notificationBackends, notificationKindsForBackend } from './notifications';

export function supportMode(env: Env, supportUrl?: string): SupportMode {
	const canNotify = notificationBackends(env).some(
		(backend) =>
			notificationKindsForBackend(env, backend).has('support.request') &&
			(backend !== 'smtp' || (parseList(env.MARIMOHUB_NOTIFY_SMTP_ADMIN_TO)?.length ?? 0) > 0),
	);
	const mode = parseEnumOr(
		env,
		'MARIMOHUB_SUPPORT_MODE',
		SupportModeSchema.options,
		canNotify ? 'notifier' : supportUrl ? 'url' : 'off',
	);
	if (mode === 'notifier' && !canNotify) {
		throw new ConfigError(
			'MARIMOHUB_SUPPORT_MODE=notifier requires a notification destination accepting support.request',
			{
				variable: 'MARIMOHUB_SUPPORT_MODE',
				docs: 'docs/support.md',
			},
		);
	}
	if (mode === 'url' && !supportUrl) {
		throw new ConfigError('MARIMOHUB_SUPPORT_MODE=url requires MARIMOHUB_THEME_SUPPORT_URL', {
			variable: 'MARIMOHUB_SUPPORT_MODE',
			docs: 'docs/support.md',
		});
	}
	return mode;
}
