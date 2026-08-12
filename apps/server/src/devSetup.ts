import type { ApiDeps } from '@marimo-hub/api';
import { UserId } from '@marimo-hub/core';

const DEV_USER_ID = UserId.parse('user');
const DEV_INTEGRATION_NAME = 'local-development';

export function localDevEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return {
		...env,
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'local',
		MARIMOHUB_AUTH_BACKEND: 'dev',
		MARIMOHUB_AUTH_DEV_USER_ID: DEV_USER_ID,
		MARIMOHUB_AUTH_DEV_EMAIL: 'user@localhost',
		MARIMOHUB_AUTH_DEV_NAME: 'Local Dev Super Admin',
		MARIMOHUB_SUPER_ADMINS: DEV_USER_ID,
		MARIMOHUB_INTEGRATIONS: 'on',
		MARIMOHUB_INTEGRATIONS_PROBE: 'private',
		MARIMOHUB_DATA_BROWSER: 'metadata',
	};
}

export async function seedLocalDev(deps: Pick<ApiDeps, 'orgIntegrations'>): Promise<void> {
	const integrations = deps.orgIntegrations;
	if (!integrations) throw new Error('Local development integrations are not enabled.');
	if ((await integrations.list()).some(({ name }) => name === DEV_INTEGRATION_NAME)) return;

	await integrations.create(
		{
			kind: 'custom_env',
			name: DEV_INTEGRATION_NAME,
			config: { vars: { LOCAL_DEV_EXAMPLE: 'true' } },
			change_note: 'Seeded by pnpm dev',
		},
		DEV_USER_ID,
	);
}
