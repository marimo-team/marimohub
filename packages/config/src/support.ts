import { ConfigError } from './errors';
import type { Env } from './env';
import { parseList, parseOnOff } from './env';
import { notificationBackends, notificationKindsForBackend } from './notifications';

export function supportReports(env: Env): boolean {
	const enabled = parseOnOff(env, 'MARIMOHUB_SUPPORT_REPORTS', {
		fallback: false,
		docs: 'docs/support.md',
	});
	if (!enabled) return false;
	const canNotify = notificationBackends(env).some(
		(backend) =>
			notificationKindsForBackend(env, backend).has('support.request') &&
			(backend !== 'smtp' || (parseList(env.MARIMOHUB_NOTIFY_SMTP_ADMIN_TO)?.length ?? 0) > 0),
	);
	if (!canNotify) {
		throw new ConfigError(
			'MARIMOHUB_SUPPORT_REPORTS=on requires a notification destination accepting support.request',
			{
				variable: 'MARIMOHUB_SUPPORT_REPORTS',
				docs: 'docs/support.md',
			},
		);
	}
	return true;
}
