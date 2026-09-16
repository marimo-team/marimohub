import { parseSecondsEnv } from './env';
export const DEFAULT_SESSION_MAX_LIFETIME_S = 14_400;
export const DEFAULT_SESSION_IDLE_TIMEOUT_S = 1_800;

export function parseSessionIdleTimeouts(
	env: Partial<
		Record<
			'MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS' | 'MARIMOHUB_SESSION_APP_IDLE_TIMEOUT_SECONDS',
			string
		>
	>,
) {
	const edit = parseSecondsEnv(env, 'MARIMOHUB_SESSION_IDLE_TIMEOUT_SECONDS', {
		dflt: DEFAULT_SESSION_IDLE_TIMEOUT_S,
	});
	const app = parseSecondsEnv(env, 'MARIMOHUB_SESSION_APP_IDLE_TIMEOUT_SECONDS', {
		dflt: edit / 1000,
	});
	return { edit, app };
}
