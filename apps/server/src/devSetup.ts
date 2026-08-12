import type { ApiDeps } from '@marimo-hub/api';
import { UserId, ValidationError } from '@marimo-hub/core';
import type { CreateIntegrationInput } from '@marimo-hub/core';

const DEV_USER = {
	id: UserId.parse('user'),
	email: 'user@localhost',
	name: 'Local Dev Super Admin',
} as const;

const DEV_INTEGRATION = {
	kind: 'custom_env',
	name: 'local-development',
	config: { vars: { LOCAL_DEV_EXAMPLE: 'true' } },
	change_note: 'Seeded by pnpm dev',
} satisfies CreateIntegrationInput;

const DEV_INTEGRATION_CONFLICT = `An integration named "${DEV_INTEGRATION.name}" already exists at the org level.`;

async function hasDevIntegration(integrations: NonNullable<ApiDeps['orgIntegrations']>) {
	return (await integrations.list()).some(
		({ kind, name }) => kind === DEV_INTEGRATION.kind && name === DEV_INTEGRATION.name,
	);
}

export function localDevEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	return {
		...env,
		MARIMOHUB_STORAGE_BACKEND: 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
		MARIMOHUB_COMPUTE_BACKEND: 'local',
		MARIMOHUB_AUTH_BACKEND: 'dev',
		MARIMOHUB_AUTH_DEV_USER_ID: DEV_USER.id,
		MARIMOHUB_AUTH_DEV_EMAIL: DEV_USER.email,
		MARIMOHUB_AUTH_DEV_NAME: DEV_USER.name,
		MARIMOHUB_SUPER_ADMINS: DEV_USER.email,
		MARIMOHUB_INTEGRATIONS: 'on',
		MARIMOHUB_INTEGRATIONS_PROBE: 'private',
		MARIMOHUB_DATA_BROWSER: 'metadata',
	};
}

export async function seedLocalDev(deps: Pick<ApiDeps, 'orgIntegrations'>): Promise<void> {
	const integrations = deps.orgIntegrations;
	if (!integrations) throw new Error('Local development integrations are not enabled.');
	if (await hasDevIntegration(integrations)) return;

	try {
		await integrations.create(DEV_INTEGRATION, DEV_USER.id);
	} catch (error) {
		if (
			error instanceof ValidationError &&
			error.message === DEV_INTEGRATION_CONFLICT &&
			(await hasDevIntegration(integrations))
		)
			return;
		throw error;
	}
}
