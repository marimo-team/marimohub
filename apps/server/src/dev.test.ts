import { describe, expect, it, vi } from 'vitest';
import { createApi } from '@marimo-hub/api';
import { ensureInitialized, UserId, ValidationError } from '@marimo-hub/core';
import type { OrgIntegrationsService } from '@marimo-hub/core';
import { createFromEnv } from '@marimo-hub/config';
import { localDevEnv, seedLocalDev } from './devSetup';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('local development setup', () => {
	const createDevDeps = () => createFromEnv(localDevEnv({ PORT: '4321' }));
	const noServices = { MARIMOHUB_DEV_SERVICES: 'off' };
	const nameConflict = () =>
		new ValidationError(
			'An integration named "local-development" already exists at the org level.',
		);

	it('overrides conflicting deployment values', () => {
		const env = localDevEnv({
			PORT: '4321',
			MARIMOHUB_STORAGE_BACKEND: 's3',
			MARIMOHUB_AUTH_DEV_USER_ID: 'other-user',
			MARIMOHUB_AUTH_DEV_EMAIL: 'other@example.com',
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
			MARIMOHUB_DATA_BROWSER: 'full',
			MARIMOHUB_DATA_PREVIEW_IMAGE: 'ghcr.io/marimo-team/marimo-sandbox:latest',
			MARIMOHUB_EXPERIMENTS: 'duckdb-wasm-preview',
		});
		expect(env.MARIMOHUB_SECRETS_KEK).toBeTruthy();
	});

	it('keeps caller overrides for experiments and the secrets KEK', () => {
		const env = localDevEnv({
			MARIMOHUB_EXPERIMENTS: '',
			MARIMOHUB_SECRETS_KEK: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
		});

		expect(env).toMatchObject({
			MARIMOHUB_EXPERIMENTS: '',
			MARIMOHUB_SECRETS_KEK: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
		});
	});

	it('generates a fresh KEK per process for ephemeral storage', () => {
		const first = localDevEnv({}).MARIMOHUB_SECRETS_KEK;
		const second = localDevEnv({}).MARIMOHUB_SECRETS_KEK;

		expect(first).toBeTruthy();
		expect(first).not.toBe(second);
	});

	it('reuses the persisted KEK across restarts when persistence is requested', () => {
		const first = localDevEnv({ MARIMOHUB_DEV_PERSIST: 'true' }).MARIMOHUB_SECRETS_KEK;
		const second = localDevEnv({ MARIMOHUB_DEV_PERSIST: 'true' }).MARIMOHUB_SECRETS_KEK;

		expect(first).toBeTruthy();
		expect(first).toBe(second);
	});

	it('uses filesystem storage only when persistence is requested', () => {
		const env = localDevEnv({ MARIMOHUB_DEV_PERSIST: 'true' });

		expect(env).toMatchObject({
			MARIMOHUB_STORAGE_BACKEND: 'fs',
			MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: 'false',
		});
		expect(env.MARIMOHUB_STORAGE_FS_ROOT).toMatch(/\.context\/dev-storage$/);
	});

	it('seeds a welcome notebook and one org-wide integration once', async () => {
		const deps = createDevDeps();

		await seedLocalDev(deps, noServices);
		await seedLocalDev(deps, noServices);

		const projects = await deps.services.projects.listProjects();
		expect(projects).toHaveLength(1);
		expect(await deps.services.notebooks.listNotebooks(projects[0].id)).toEqual([
			expect.objectContaining({ title: 'Welcome to marimohub', tags: ['example'] }),
		]);

		expect(await deps.orgIntegrations?.list()).toEqual([
			expect.objectContaining({
				kind: 'custom_env',
				name: 'local-development',
				created_by: 'user',
				scope: 'org',
			}),
		]);
	});

	it('seeds S3 and Iceberg integrations when the local services respond', async () => {
		const deps = createDevDeps();
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
		try {
			await seedLocalDev(deps, {});
			await seedLocalDev(deps, {});
		} finally {
			vi.unstubAllGlobals();
		}

		const listed = await deps.orgIntegrations?.list();
		expect(listed).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 's3', name: 'local-minio', scope: 'org' }),
				expect.objectContaining({ kind: 'iceberg_rest', name: 'local-iceberg', scope: 'org' }),
			]),
		);
		expect(listed).toHaveLength(3);
		const iceberg = listed?.find((entry) => entry.name === 'local-iceberg');
		if (!iceberg) throw new Error('Expected the local Iceberg integration.');
		expect(await deps.orgIntegrations?.get(iceberg.id)).toMatchObject({
			config: {
				storage: {
					broker_read_locations: [{ bucket: 'warehouse', prefix: 'demo' }],
				},
			},
		});
	});

	it('skips service integrations when the local services are down', async () => {
		const deps = createDevDeps();
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
		try {
			await seedLocalDev(deps, {});
		} finally {
			vi.unstubAllGlobals();
		}

		expect(await deps.orgIntegrations?.list()).toEqual([
			expect.objectContaining({ kind: 'custom_env', name: 'local-development' }),
		]);
	});

	it('does not mutate storage when integrations are unavailable', async () => {
		const deps = createDevDeps();

		await expect(seedLocalDev({ ...deps, orgIntegrations: undefined }, noServices)).rejects.toThrow(
			'Local development integrations are not enabled.',
		);

		expect((await deps.bucket.list()).objects).toEqual([]);
	});

	it('creates one welcome notebook across concurrent startups', async () => {
		const deps = createDevDeps();
		await ensureInitialized(deps.bucket, UserId.parse('user'));
		const createNotebook = vi.spyOn(deps.services.notebooks, 'createNotebook');

		await Promise.all([seedLocalDev(deps, noServices), seedLocalDev(deps, noServices)]);

		expect(createNotebook).toHaveBeenCalledOnce();
		const [project] = await deps.services.projects.listProjects();
		expect(await deps.services.notebooks.listNotebooks(project.id)).toHaveLength(1);
	});

	it('renews the seed claim while notebook creation is in progress', async () => {
		const deps = createDevDeps();
		await ensureInitialized(deps.bucket, UserId.parse('user'));
		const originalCreate = deps.services.notebooks.createNotebook.bind(deps.services.notebooks);
		const createDidStart = deferred();
		const createCanFinish = deferred();
		const createNotebook = vi
			.spyOn(deps.services.notebooks, 'createNotebook')
			.mockImplementationOnce(async (...args) => {
				createDidStart.resolve();
				await createCanFinish.promise;
				return originalCreate(...args);
			});

		vi.useFakeTimers();
		try {
			const first = seedLocalDev(deps, noServices);
			await createDidStart.promise;
			await vi.advanceTimersByTimeAsync(31_000);

			const second = seedLocalDev(deps, noServices);
			await vi.advanceTimersByTimeAsync(25);
			expect(createNotebook).toHaveBeenCalledOnce();

			createCanFinish.resolve();
			await first;
			await vi.advanceTimersByTimeAsync(25);
			await second;

			expect(createNotebook).toHaveBeenCalledOnce();
			const [project] = await deps.services.projects.listProjects();
			expect(await deps.services.notebooks.listNotebooks(project.id)).toHaveLength(1);
		} finally {
			createCanFinish.resolve();
			vi.useRealTimers();
		}
	});

	it('retries the notebook seed when the concurrent holder fails', async () => {
		const deps = createDevDeps();
		await ensureInitialized(deps.bucket, UserId.parse('user'));
		const originalCreate = deps.services.notebooks.createNotebook.bind(deps.services.notebooks);
		const firstCanFail = deferred();
		const firstDidStart = deferred();
		const secondSawClaim = deferred();
		const originalGet = deps.bucket.get.bind(deps.bucket);
		vi.spyOn(deps.bucket, 'get').mockImplementation(async (key) => {
			const object = await originalGet(key);
			if (key === '_system/dev/local-notebook-seed.json' && object) secondSawClaim.resolve();
			return object;
		});
		const createNotebook = vi
			.spyOn(deps.services.notebooks, 'createNotebook')
			.mockImplementationOnce(async () => {
				firstDidStart.resolve();
				await firstCanFail.promise;
				throw new Error('first seed failed');
			})
			.mockImplementation(originalCreate);

		const first = seedLocalDev(deps, noServices);
		await firstDidStart.promise;
		const second = seedLocalDev(deps, noServices);
		await secondSawClaim.promise;
		expect(createNotebook).toHaveBeenCalledOnce();

		firstCanFail.resolve();
		await expect(first).rejects.toThrow('first seed failed');
		await expect(second).resolves.toBeUndefined();

		expect(createNotebook).toHaveBeenCalledTimes(2);
		const [project] = await deps.services.projects.listProjects();
		expect(await deps.services.notebooks.listNotebooks(project.id)).toHaveLength(1);
	});

	it('reclaims an expired seed claim even when its PID is live', async () => {
		const deps = createDevDeps();
		await deps.bucket.put(
			'_system/dev/local-notebook-seed.json',
			JSON.stringify({ holder: `${process.pid}:${Date.now() - 60_000}:previous-process` }),
		);

		await seedLocalDev(deps, noServices);

		const [project] = await deps.services.projects.listProjects();
		expect(await deps.services.notebooks.listNotebooks(project.id)).toHaveLength(1);
	});

	it('ignores an atomic name conflict from another startup', async () => {
		const create = vi.fn().mockRejectedValue(nameConflict());
		const list = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ name: 'local-development', kind: 'custom_env' }]);
		const orgIntegrations = { list, create };
		const deps = createDevDeps();

		await expect(
			seedLocalDev(
				{
					...deps,
					orgIntegrations: orgIntegrations as unknown as OrgIntegrationsService,
				},
				noServices,
			),
		).resolves.toBeUndefined();
		expect(create).toHaveBeenCalledOnce();
	});

	it('surfaces a name conflict with another integration kind', async () => {
		const conflict = nameConflict();
		const create = vi.fn().mockRejectedValue(conflict);
		const orgIntegrations = {
			list: vi.fn().mockResolvedValue([{ name: 'local-development', kind: 'postgres' }]),
			create,
		};
		const deps = createDevDeps();

		await expect(
			seedLocalDev(
				{
					...deps,
					orgIntegrations: orgIntegrations as unknown as OrgIntegrationsService,
				},
				noServices,
			),
		).rejects.toBe(conflict);

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'local-development', kind: 'custom_env' }),
			'user',
		);
	});

	it('allows the authenticated dev user to reach the super-admin API', async () => {
		const deps = createDevDeps();
		const response = await createApi(deps).request('/api/v1/admin/config');

		expect(response.status).toBe(200);
	});
});
