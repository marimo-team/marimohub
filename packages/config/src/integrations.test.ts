import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createProjectId,
	createSessionId,
	DataPreviewService,
	DataQueryService,
	icebergRest,
} from '@marimo-hub/core';
import type { DataQueryExecution } from '@marimo-hub/core';
import { ACTOR, MemoryBucket } from '@marimo-hub/core/testing';
import { DEFAULT_POSTGRES_RUNTIME_LIMITS } from '@marimo-hub/postgres-runtime/node';
import { ConfigError } from './errors';
import type * as integrationProbe from './integrationProbe';
import { createGuardedHostResolver } from './integrationProbe';
import {
	makeIntegrations,
	objectBrowserDeadlinesFromEnv,
	objectBrowserLimitsFromEnv,
} from './integrations';

vi.mock('./integrationProbe', async (importOriginal) => {
	const actual = await importOriginal<typeof integrationProbe>();
	return { ...actual, createGuardedHostResolver: vi.fn(actual.createGuardedHostResolver) };
});

const PG_CONFIG = { host: 'db.internal', database: 'db', username: 'u', password: 'pw' };

afterEach(() => vi.restoreAllMocks());

describe('makeIntegrations', () => {
	it('is enabled by default and supports an explicit on/off kill switch', () => {
		const defaultWiring = makeIntegrations({}, new MemoryBucket());
		expect(defaultWiring.integrations).toBeDefined();
		expect(defaultWiring.orgIntegrations).toBeDefined();

		expect(makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'off' }, new MemoryBucket())).toEqual({});
		const wired = makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'on' }, new MemoryBucket());
		expect(wired.integrations).toBeDefined();
		expect(wired.orgIntegrations).toBeDefined();

		for (const value of ['true', 'none']) {
			expect(() => makeIntegrations({ MARIMOHUB_INTEGRATIONS: value }, new MemoryBucket())).toThrow(
				ConfigError,
			);
		}
	});

	it('org and project tiers share one bucket: org instances inherit into projects', async () => {
		const bucket = new MemoryBucket();
		const { integrations, orgIntegrations } = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on' },
			bucket,
		);
		await orgIntegrations?.create(
			{ kind: 'custom_env', name: 'org-flags', config: { vars: { ORG_FLAG: 'on' } } },
			ACTOR,
		);
		const entries = await integrations?.list(createProjectId());
		expect(entries).toEqual([expect.objectContaining({ name: 'org-flags', scope: 'org' })]);
	});

	it('rejects unknown values for the switch and the probe policy', () => {
		expect(() => makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'bogus' }, new MemoryBucket())).toThrow(
			ConfigError,
		);
		expect(() =>
			makeIntegrations(
				{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_INTEGRATIONS_PROBE: 'bogus' },
				new MemoryBucket(),
			),
		).toThrow(ConfigError);
	});

	it('the probe policy gates testing: off ⇒ every kind reports supports_test false', () => {
		const off = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_INTEGRATIONS_PROBE: 'off' },
			new MemoryBucket(),
		).integrations;
		expect(off?.listKinds().every((k) => !k.supports_test)).toBe(true);

		for (const probe of [undefined, 'private']) {
			const wired = makeIntegrations(
				{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_INTEGRATIONS_PROBE: probe },
				new MemoryBucket(),
			).integrations;
			expect(wired?.listKinds().some((k) => k.supports_test)).toBe(true);
		}
	});

	it('secret config fields require the shared KEK', async () => {
		const pid = createProjectId();
		const input = { kind: 'postgres', name: 'db', config: PG_CONFIG };

		const noKek = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on' },
			new MemoryBucket(),
		).integrations;
		await expect(noKek?.create(pid, input, ACTOR)).rejects.toThrow(/MARIMOHUB_SECRETS_KEK/);

		const withKek = makeIntegrations(
			{
				MARIMOHUB_INTEGRATIONS: 'on',
				MARIMOHUB_SECRETS_KEK: 'sBN3HR4/RHc81JkWZ794UoUuUnPEHvt7zvkBjjbTWk0=',
			},
			new MemoryBucket(),
		).integrations;
		const detail = await withKek?.create(pid, input, ACTOR);
		expect(detail?.config.password).toEqual({ $secret: { kind: 'managed', set: true } });
	});

	it('advertises and uses configured external secret sources', async () => {
		const integrations = makeIntegrations(
			{
				MARIMOHUB_INTEGRATIONS: 'on',
				MARIMOHUB_SECRETS_AWS_REGION: 'us-east-1',
			},
			new MemoryBucket(),
		).integrations;
		expect(integrations?.listKinds()[0].secret_sources).toMatchObject({
			inline: false,
			references: [{ backend: 'aws-sm', title: 'AWS Secrets Manager' }],
		});
	});
});

describe('makeIntegrations data browser', () => {
	it('defaults to metadata; explicit off disables the capability and browse support', () => {
		const defaulted = makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'on' }, new MemoryBucket());
		expect(defaulted.dataBrowser).toMatchObject({ preview: false });
		expect(defaulted.integrations?.listKinds().some((k) => k.supports_browse)).toBe(true);

		const dark = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'off' },
			new MemoryBucket(),
		);
		expect(dark.dataBrowser).toBeUndefined();
		expect(dark.integrations?.listKinds().every((k) => !k.supports_browse)).toBe(true);

		const wired = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'metadata' },
			new MemoryBucket(),
		);
		expect(wired.dataBrowser).toMatchObject({
			preview: false,
			objectBrowser: {
				allowServerAmbientCredentials: false,
				maxConcurrentDownloads: 16,
				maxConcurrentDownloadsPerUser: 2,
				downloadTimeoutMs: 3_600_000,
			},
		});
		expect(wired.integrations?.listKinds().some((k) => k.supports_browse)).toBe(true);
		expect(wired.integrations?.listKinds().find((kind) => kind.kind === 's3')).toMatchObject({
			supports_test: true,
			supports_browse: true,
			browse_surfaces: ['objects'],
		});
		for (const kind of ['gcs', 'azure_blob']) {
			expect(wired.integrations?.listKinds().find((item) => item.kind === kind)).toMatchObject({
				supports_browse: true,
				browse_surfaces: ['objects'],
			});
		}

		const full = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'full' },
			new MemoryBucket(),
		);
		expect(full.dataBrowser).toMatchObject({ preview: true });
	});

	it('ignores stale preview timeout values while data browsing is disabled', () => {
		expect(() =>
			makeIntegrations(
				{
					MARIMOHUB_INTEGRATIONS: 'on',
					MARIMOHUB_DATA_BROWSER: 'off',
					MARIMOHUB_DATA_PREVIEW_EXECUTION_TIMEOUT_SECONDS: 'stale-invalid-value',
				},
				new MemoryBucket(),
			),
		).not.toThrow();
	});

	it('does not parse preview-only deadlines in metadata mode', () => {
		expect(() =>
			makeIntegrations(
				{
					MARIMOHUB_INTEGRATIONS: 'on',
					MARIMOHUB_DATA_BROWSER: 'metadata',
					MARIMOHUB_OBJECT_BROWSER_PREVIEW_TIMEOUT_SECONDS: 'stale-invalid-value',
					MARIMOHUB_OBJECT_BROWSER_DOWNLOAD_TIMEOUT_SECONDS: 'stale-invalid-value',
				},
				new MemoryBucket(),
			),
		).not.toThrow();
		expect(
			objectBrowserDeadlinesFromEnv(
				{ MARIMOHUB_OBJECT_BROWSER_PREVIEW_TIMEOUT_SECONDS: 'stale-invalid-value' },
				'metadata',
			),
		).toEqual({
			metadataTimeoutMs: 30_000,
			previewTimeoutMs: 30_000,
			resolveTimeoutMs: 30_000,
		});
	});

	it('gives DNS resolution enough time for the longest active browser operation', () => {
		expect(
			objectBrowserDeadlinesFromEnv(
				{ MARIMOHUB_OBJECT_BROWSER_PREVIEW_TIMEOUT_SECONDS: '45' },
				'full',
			),
		).toEqual({
			metadataTimeoutMs: 30_000,
			previewTimeoutMs: 45_000,
			resolveTimeoutMs: 45_000,
		});
		expect(
			objectBrowserDeadlinesFromEnv(
				{
					MARIMOHUB_OBJECT_BROWSER_METADATA_TIMEOUT_SECONDS: '20',
					MARIMOHUB_OBJECT_BROWSER_PREVIEW_TIMEOUT_SECONDS: '5',
				},
				'full',
			),
		).toEqual({
			metadataTimeoutMs: 20_000,
			previewTimeoutMs: 5_000,
			resolveTimeoutMs: 20_000,
		});
	});

	it('wires aggregate preview lifecycle only when a preview service is supplied', () => {
		const runtime = new DataPreviewService({ maxConcurrent: 1, maxConcurrentPerUser: 1 });
		const without = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'full' },
			new MemoryBucket(),
		);
		expect(without.dataBrowser).toMatchObject({ preview: true });
		expect(without.dataBrowser?.checkPreview).toBeUndefined();
		const withRuntime = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'full' },
			new MemoryBucket(),
			undefined,
			runtime,
		);
		expect(withRuntime.dataBrowser?.checkPreview).toBeTypeOf('function');
		expect(withRuntime.dataBrowser?.close).toBeTypeOf('function');
	});

	it('keeps Run SQL off by default and enables an explicitly injected isolated service', async () => {
		const env = { MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'full' };
		const without = makeIntegrations(env, new MemoryBucket());
		expect(without.dataBrowser?.query).toBe(false);

		const executions: DataQueryExecution[] = [];
		const dataQuery = new DataQueryService({
			executorFactory: {
				create: async () => ({
					runtime: 'worker',
					execute: async (request) => {
						executions.push(request);
						return { columns: ['value'], rows: [[1]], truncated: false };
					},
					terminate: () => {},
				}),
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
			maxRows: 10,
			maxBytes: 4096,
			executionTimeoutMs: 1000,
		});
		vi.spyOn(icebergRest.query!, 'available').mockReturnValue({ ok: true });
		const wired = makeIntegrations(env, new MemoryBucket(), undefined, undefined, dataQuery);
		expect(wired.dataBrowser?.query).toBe(true);
		const pid = createProjectId();
		const created = await wired.integrations!.create(
			pid,
			{
				kind: 'iceberg_rest',
				name: 'source',
				config: {
					uri: 'https://catalog.example.com',
					auth: { method: 'none' },
					access_delegation: 'none',
					storage: {
						scheme: 's3',
						endpoint: 'https://objects.example.com',
						anonymous: true,
						broker_read_locations: [{ bucket: 'warehouse', prefix: 'tables' }],
					},
				},
			},
			ACTOR,
		);
		await expect(
			wired.integrations!.runDataQuery(
				pid,
				created.id,
				{ userId: ACTOR, email: 'actor@example.com' },
				createSessionId(),
				'select 1',
			),
		).resolves.toEqual({
			columns: ['value'],
			rows: [[1]],
			truncated: false,
			execution_ms: expect.any(Number),
		});
		expect(executions).toHaveLength(1);
		await wired.dataBrowser?.close?.();
	});

	it('advertises PostgreSQL testing by default and browsing only behind its rollout flag', () => {
		const dark = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'off' },
			new MemoryBucket(),
		);
		const wired = makeIntegrations(
			{
				MARIMOHUB_INTEGRATIONS: 'on',
				MARIMOHUB_DATA_BROWSER: 'metadata',
				MARIMOHUB_INTEGRATIONS_PROBE: 'private',
			},
			new MemoryBucket(),
		);
		const enabled = makeIntegrations(
			{
				MARIMOHUB_INTEGRATIONS: 'on',
				MARIMOHUB_DATA_BROWSER: 'metadata',
				MARIMOHUB_INTEGRATIONS_PROBE: 'private',
				MARIMOHUB_POSTGRES_DATA_ACCESS: 'on',
			},
			new MemoryBucket(),
		);

		expect(dark.integrations?.listKinds().find((kind) => kind.kind === 'postgres')).toMatchObject({
			supports_test: true,
			supports_browse: false,
			browse_surfaces: [],
		});
		expect(wired.integrations?.listKinds().find((kind) => kind.kind === 'postgres')).toMatchObject({
			supports_test: true,
			supports_browse: false,
			browse_surfaces: [],
		});
		expect(
			enabled.integrations?.listKinds().find((kind) => kind.kind === 'postgres'),
		).toMatchObject({
			supports_browse: true,
			browse_surfaces: ['tables'],
		});
	});

	it.each(['disable', 'prefer', 'require'] as const)(
		'blocks PostgreSQL %s connection tests without the insecure-transport override',
		async (mode) => {
			const integrations = makeIntegrations(
				{
					MARIMOHUB_DATA_BROWSER: 'off',
					MARIMOHUB_INTEGRATIONS_PROBE: 'private',
				},
				new MemoryBucket(),
			).integrations!;

			await expect(
				integrations.test(createProjectId(), {
					source: 'draft',
					kind: 'postgres',
					config: { ...PG_CONFIG, ssl: { mode } },
				}),
			).resolves.toEqual({
				ok: false,
				details: 'MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT is not on',
			});
		},
	);

	it('enables bounded vended S3 queries without rollout configuration', () => {
		const config = {
			uri: 'https://catalog.example.com/iceberg',
			auth: { method: 'none' },
			storage: {
				scheme: 'catalog',
				vended_s3: {
					endpoint: 'https://objects.example.com',
					allowed_locations: [{ bucket: 'warehouse', prefix: 'production' }],
				},
			},
			access_delegation: 'vended_credentials',
		};
		const integrations = makeIntegrations({}, new MemoryBucket()).integrations;

		expect(
			integrations?.queryReadiness({ kind: 'iceberg_rest', config }).every((check) => check.ready),
		).toBe(true);
	});

	it('passes metadata and full modes to every production object browser', async () => {
		for (const [mode, expected] of [
			['metadata', { preview: false, download: false }],
			['full', { preview: true, download: true }],
		] as const) {
			const integrations = makeIntegrations(
				{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: mode },
				new MemoryBucket(),
			).integrations!;
			const pid = createProjectId();
			for (const [kind, config] of [
				['s3', { auth: { method: 'ambient' } }],
				['gcs', { auth: { method: 'ambient' } }],
				['azure_blob', { account_name: 'lakeaccount', auth: { method: 'ambient' } }],
			] as const) {
				const created = await integrations.create(
					pid,
					{ kind, name: `${kind.replaceAll('_', '-')}-${mode}`, config },
					ACTOR,
				);
				const capability = await integrations.browseCapability(pid, created.id, {
					project_id: pid,
					user_id: ACTOR,
					user_email: 'user@example.com',
					allow_server_ambient: { s3: true, gcs: true, azure_blob: true },
				});
				expect(capability.surfaces.objects).toMatchObject({
					available: true,
					provider: kind,
					...expected,
				});
			}
		}
	});

	it('delegates aggregate preview preflight', async () => {
		let checked = false;
		const runtime = new DataPreviewService({
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
			sandbox: {
				available: () => checked,
				check: async () => {
					checked = true;
				},
				preview: async () => ({ columns: [], rows: [] }),
				close: async () => {},
			},
		});
		const wired = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'full' },
			new MemoryBucket(),
			undefined,
			runtime,
		);
		expect(checked).toBe(false);
		await wired.dataBrowser?.checkPreview?.();
		expect(checked).toBe(true);
	});

	it('allows browsing by default and rejects it when integrations are disabled', () => {
		expect(
			makeIntegrations({ MARIMOHUB_DATA_BROWSER: 'metadata' }, new MemoryBucket()).dataBrowser,
		).toBeDefined();
		expect(() =>
			makeIntegrations(
				{ MARIMOHUB_INTEGRATIONS: 'off', MARIMOHUB_DATA_BROWSER: 'metadata' },
				new MemoryBucket(),
			),
		).toThrow(ConfigError);
	});

	it('refuses to enable browsing without a probe', () => {
		expect(() =>
			makeIntegrations(
				{
					MARIMOHUB_INTEGRATIONS: 'on',
					MARIMOHUB_INTEGRATIONS_PROBE: 'off',
					MARIMOHUB_DATA_BROWSER: 'metadata',
				},
				new MemoryBucket(),
			),
		).toThrow(/probe/);
	});

	it('the metadata default yields silently to a disabled probe or integrations gate', () => {
		const probeOff = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_INTEGRATIONS_PROBE: 'off' },
			new MemoryBucket(),
		);
		expect(probeOff.dataBrowser).toBeUndefined();
		expect(probeOff.integrations?.listKinds().every((k) => !k.supports_browse)).toBe(true);

		expect(
			makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'off' }, new MemoryBucket()).dataBrowser,
		).toBeUndefined();
	});

	it('rejects unknown values', () => {
		for (const value of ['bogus']) {
			expect(() =>
				makeIntegrations(
					{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: value },
					new MemoryBucket(),
				),
			).toThrow(/supported: off, metadata, full/);
		}
	});

	it('rejects invalid object-browser operation deadlines', () => {
		for (const value of ['0', '-1', 'not-a-number', '2147484']) {
			for (const key of [
				'MARIMOHUB_OBJECT_BROWSER_METADATA_TIMEOUT_SECONDS',
				'MARIMOHUB_OBJECT_BROWSER_PREVIEW_TIMEOUT_SECONDS',
			] as const) {
				expect(() =>
					makeIntegrations(
						{
							MARIMOHUB_INTEGRATIONS: 'on',
							MARIMOHUB_DATA_BROWSER: 'full',
							[key]: value,
						},
						new MemoryBucket(),
					),
				).toThrow(/expected .*integer/);
			}
		}
	});

	it('parses object-browser limits and rejects unsafe combinations', () => {
		expect(
			objectBrowserLimitsFromEnv(
				{
					MARIMOHUB_OBJECT_BROWSER_PREVIEW_MAX_BYTES: '1024',
					MARIMOHUB_OBJECT_BROWSER_INLINE_IMAGE_MAX_BYTES: '2048',
					MARIMOHUB_OBJECT_BROWSER_PARQUET_MAX_RANGED_BYTES: '4096',
					MARIMOHUB_OBJECT_BROWSER_SEARCH_MAX_KEYS: '250',
				},
				'full',
			),
		).toEqual({
			previewMaxBytes: 1024,
			inlineImageMaxBytes: 2048,
			parquetMaxRangedBytes: 4096,
			searchMaxKeys: 250,
		});

		for (const value of ['0', '-1', 'not-an-integer', '9007199254740992']) {
			expect(() =>
				makeIntegrations(
					{
						MARIMOHUB_INTEGRATIONS: 'on',
						MARIMOHUB_DATA_BROWSER: 'full',
						MARIMOHUB_OBJECT_BROWSER_SEARCH_MAX_KEYS: value,
					},
					new MemoryBucket(),
				),
			).toThrow(ConfigError);
		}
		expect(() =>
			makeIntegrations(
				{
					MARIMOHUB_INTEGRATIONS: 'on',
					MARIMOHUB_DATA_BROWSER: 'full',
					MARIMOHUB_OBJECT_BROWSER_MAX_CONCURRENT_DOWNLOADS: '2',
					MARIMOHUB_OBJECT_BROWSER_MAX_CONCURRENT_DOWNLOADS_PER_USER: '3',
				},
				new MemoryBucket(),
			),
		).toThrow(/cannot exceed/);
	});
});

describe('makeIntegrations data-browser lockdown', () => {
	it('normalizes case and whitespace in the data-browser setting', () => {
		const shouty = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: ' METADATA ' },
			new MemoryBucket(),
		);
		expect(shouty.dataBrowser).toMatchObject({ preview: false });

		expect(
			makeIntegrations(
				{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: ' OFF ' },
				new MemoryBucket(),
			).dataBrowser,
		).toBeUndefined();
	});

	it('treats a whitespace-only setting as the default, so it still yields to a disabled probe', () => {
		const degraded = makeIntegrations(
			{
				MARIMOHUB_INTEGRATIONS: 'on',
				MARIMOHUB_INTEGRATIONS_PROBE: 'off',
				MARIMOHUB_DATA_BROWSER: '   ',
			},
			new MemoryBucket(),
		);
		expect(degraded.dataBrowser).toBeUndefined();
	});

	it('rejects invalid data-browser values even when integrations are off', () => {
		expect(() =>
			makeIntegrations(
				{ MARIMOHUB_INTEGRATIONS: 'off', MARIMOHUB_DATA_BROWSER: 'bogus' },
				new MemoryBucket(),
			),
		).toThrow(/supported: off, metadata, full/);
	});

	it('rejects an invalid probe policy instead of degrading the default browser', () => {
		expect(() =>
			makeIntegrations(
				{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_INTEGRATIONS_PROBE: 'bogus' },
				new MemoryBucket(),
			),
		).toThrow(/MARIMOHUB_INTEGRATIONS_PROBE/);
	});

	it('refuses explicit full mode without a probe', () => {
		expect(() =>
			makeIntegrations(
				{
					MARIMOHUB_INTEGRATIONS: 'on',
					MARIMOHUB_INTEGRATIONS_PROBE: 'off',
					MARIMOHUB_DATA_BROWSER: 'full',
				},
				new MemoryBucket(),
			),
		).toThrow(/probe/);
	});

	it('locks previews, Run SQL, and ambient credentials off in the metadata default', () => {
		const defaulted = makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'on' }, new MemoryBucket());
		expect(defaulted.dataBrowser).toMatchObject({
			preview: false,
			query: false,
			objectBrowser: { allowServerAmbientCredentials: false },
		});
		expect(defaulted.dataBrowser?.checkPreview).toBeUndefined();
	});

	it('shares one guarded resolver between object browsers and the PostgreSQL runtime', () => {
		const runtimeOptions = (env: Record<string, string>) => {
			vi.mocked(createGuardedHostResolver).mockClear();
			const store = (
				makeIntegrations(env, new MemoryBucket()).integrations as unknown as {
					store: {
						databaseTesters: { postgres: { options: Record<string, unknown> } };
						objectBrowsers?: object;
					};
				}
			).store;
			return {
				resolvers: vi.mocked(createGuardedHostResolver).mock.calls,
				postgres: store.databaseTesters.postgres.options,
				objectBrowsers: store.objectBrowsers,
			};
		};

		const browsing = runtimeOptions({ MARIMOHUB_DATA_BROWSER: 'metadata' });
		expect(browsing.resolvers).toEqual([[{ allowPrivate: false, timeoutMs: 30_000 }]]);
		expect(browsing.objectBrowsers).toBeDefined();
		expect(browsing.postgres).toMatchObject({ mode: 'metadata', metadataTimeoutMs: 30_000 });

		const testerOnly = runtimeOptions({
			MARIMOHUB_DATA_BROWSER: 'off',
			MARIMOHUB_INTEGRATIONS_PROBE: 'private',
		});
		expect(testerOnly.resolvers).toEqual([
			[{ allowPrivate: true, timeoutMs: DEFAULT_POSTGRES_RUNTIME_LIMITS.resolveTimeoutMs }],
		]);
		expect(testerOnly.objectBrowsers).toEqual({});
		expect(testerOnly.postgres).toMatchObject({
			mode: 'metadata',
			metadataTimeoutMs: DEFAULT_POSTGRES_RUNTIME_LIMITS.metadataTimeoutMs,
			previewTimeoutMs: DEFAULT_POSTGRES_RUNTIME_LIMITS.previewTimeoutMs,
			previewMaxBytes: DEFAULT_POSTGRES_RUNTIME_LIMITS.previewMaxBytes,
		});
	});

	it('keeps the PostgreSQL runtime preview-disabled in metadata mode', () => {
		const browsers = (mode: string) =>
			(
				makeIntegrations(
					{
						MARIMOHUB_INTEGRATIONS: 'on',
						MARIMOHUB_DATA_BROWSER: mode,
						MARIMOHUB_POSTGRES_DATA_ACCESS: 'on',
					},
					new MemoryBucket(),
				).integrations as unknown as {
					store: { databaseBrowsers?: { postgres?: { preview: boolean } } };
				}
			).store.databaseBrowsers;

		expect(browsers('metadata')?.postgres?.preview).toBe(false);
		expect(browsers('full')?.postgres?.preview).toBe(true);
	});

	it('refuses Run SQL end-to-end in metadata mode', async () => {
		const wired = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'metadata' },
			new MemoryBucket(),
		);
		const pid = createProjectId();
		const created = await wired.integrations!.create(
			pid,
			{ kind: 'custom_env', name: 'flags', config: { vars: { FLAG: 'on' } } },
			ACTOR,
		);
		await expect(
			wired.integrations!.runDataQuery(
				pid,
				created.id,
				{ userId: ACTOR, email: 'actor@example.com' },
				createSessionId(),
				'select 1',
			),
		).rejects.toThrow(/Run SQL is not enabled/);
	});
});

describe('PostgreSQL transport lockdown through the store', () => {
	const wire = (env: Record<string, string> = {}) =>
		makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_POSTGRES_DATA_ACCESS: 'on', ...env },
			new MemoryBucket(),
		).integrations!;

	it.each(['disable', 'prefer', 'require'])(
		'reports %s blocked in query readiness without the transport override',
		(mode) => {
			const checks = wire().queryReadiness({
				kind: 'postgres',
				config: { ...PG_CONFIG, ssl: { mode } },
			});
			expect(checks[0]).toMatchObject({
				id: 'postgres-insecure-transport',
				ready: false,
				field: 'ssl.mode',
			});
		},
	);

	it('clears the transport blocker only with the explicit override', () => {
		const checks = wire({ MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT: 'on' }).queryReadiness({
			kind: 'postgres',
			config: { ...PG_CONFIG, ssl: { mode: 'disable' } },
		});
		expect(checks.some(({ id }) => id === 'postgres-insecure-transport')).toBe(false);
	});

	it('defaults an omitted ssl block to verify-full, which passes without the override', () => {
		const checks = wire().queryReadiness({ kind: 'postgres', config: { ...PG_CONFIG } });
		expect(checks.some(({ id }) => id === 'postgres-insecure-transport')).toBe(false);
		expect(checks.find(({ id }) => id === 'postgres-ca')).toMatchObject({ ready: true });
	});

	it('blocks insecure-transport Run SQL before execution even in full mode', async () => {
		const bucket = new MemoryBucket();
		const dataQuery = new DataQueryService({
			executorFactory: {
				create: async () => ({
					runtime: 'worker',
					execute: async () => {
						throw new Error('must not execute');
					},
					terminate: () => {},
				}),
			},
			maxConcurrent: 1,
			maxConcurrentPerUser: 1,
			maxRows: 10,
			maxBytes: 4096,
			executionTimeoutMs: 1000,
		});
		const { integrations } = makeIntegrations(
			{
				MARIMOHUB_INTEGRATIONS: 'on',
				MARIMOHUB_DATA_BROWSER: 'full',
				MARIMOHUB_POSTGRES_DATA_ACCESS: 'on',
				MARIMOHUB_SECRETS_KEK: 'sBN3HR4/RHc81JkWZ794UoUuUnPEHvt7zvkBjjbTWk0=',
			},
			bucket,
			undefined,
			undefined,
			dataQuery,
		);
		const pid = createProjectId();
		const created = await integrations!.create(
			pid,
			{ kind: 'postgres', name: 'db', config: { ...PG_CONFIG, ssl: { mode: 'disable' } } },
			ACTOR,
		);
		await expect(
			integrations!.runDataQuery(
				pid,
				created.id,
				{ userId: ACTOR, email: 'actor@example.com' },
				createSessionId(),
				'select 1',
			),
		).rejects.toThrow(/MARIMOHUB_POSTGRES_ALLOW_INSECURE_TRANSPORT/);
		await dataQuery.close();
	});
});
