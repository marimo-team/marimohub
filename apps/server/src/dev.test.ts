import { describe, expect, it, vi } from 'vitest';
import { createApi } from '@marimo-hub/api';
import type { OrgIntegrationsService } from '@marimo-hub/core';
import { createFromEnv } from '@marimo-hub/config';
import { localDevEnv, seedLocalDev } from './devSetup';

describe('local development setup', () => {
	it('overrides deployment-oriented environment values with the full local setup', () => {
		const env = localDevEnv({
			PORT: '4321',
			MARIMOHUB_STORAGE_BACKEND: 's3',
			MARIMOHUB_SUPER_ADMINS: 'operator@example.com',
			MARIMOHUB_INTEGRATIONS: 'off',
			MARIMOHUB_DATA_BROWSER: 'off',
		});

		expect(env).toMatchObject({
			PORT: '4321',
			MARIMOHUB_STORAGE_BACKEND: 'memory',
			MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'true',
			MARIMOHUB_COMPUTE_BACKEND: 'local',
			MARIMOHUB_AUTH_BACKEND: 'dev',
			MARIMOHUB_AUTH_DEV_USER_ID: 'user',
			MARIMOHUB_AUTH_DEV_EMAIL: 'user@localhost',
			MARIMOHUB_SUPER_ADMINS: 'user@localhost',
			MARIMOHUB_INTEGRATIONS: 'on',
			MARIMOHUB_INTEGRATIONS_PROBE: 'private',
			MARIMOHUB_DATA_BROWSER: 'metadata',
		});
	});

	it('seeds one org-wide integration', async () => {
		const deps = createFromEnv(localDevEnv({ PORT: '4321' }));

		await seedLocalDev(deps);

		expect(await deps.orgIntegrations?.list()).toEqual([
			expect.objectContaining({
				kind: 'custom_env',
				name: 'local-development',
				created_by: 'user',
				scope: 'org',
			}),
		]);
	});

	it('does not duplicate the seed', async () => {
		const list = vi.fn().mockResolvedValue([{ name: 'local-development' }]);
		const create = vi.fn();

		await seedLocalDev({ orgIntegrations: { list, create } as unknown as OrgIntegrationsService });

		expect(create).not.toHaveBeenCalled();
	});

	it('allows the authenticated dev user to reach the super-admin API', async () => {
		const deps = createFromEnv(localDevEnv({ PORT: '4321' }));
		const response = await createApi(deps).request('/api/v1/admin/config');

		expect(deps.policy.superAdmins).toEqual(['user@localhost']);
		expect(response.status).toBe(200);
	});
});
