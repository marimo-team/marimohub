import { describe, expect, it } from 'vitest';
import {
	createProjectId,
	createSessionId,
	DataPreviewService,
	DataQueryService,
} from '@marimo-hub/core';
import type { DataQueryExecution } from '@marimo-hub/core';
import { ACTOR, MemoryBucket } from '@marimo-hub/core/testing';
import { ConfigError } from './errors';
import {
	makeIntegrations,
	objectBrowserDeadlinesFromEnv,
	objectBrowserLimitsFromEnv,
} from './integrations';

const PG_CONFIG = { host: 'db.internal', database: 'db', username: 'u', password: 'pw' };

describe('makeIntegrations', () => {
	it('is OPT-IN (two-phase rollout): unset/off disabled, on enabled', () => {
		expect(makeIntegrations({}, new MemoryBucket())).toEqual({});
		expect(makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'off' }, new MemoryBucket())).toEqual({});
		expect(makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'none' }, new MemoryBucket())).toEqual({});
		const wired = makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'on' }, new MemoryBucket());
		expect(wired.integrations).toBeDefined();
		expect(wired.orgIntegrations).toBeDefined();
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
	it('is off by default; metadata wires the capability and browse support', () => {
		const dark = makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'on' }, new MemoryBucket());
		expect(dark.dataBrowser).toBeUndefined();
		expect(dark.integrations?.listKinds().every((k) => !k.supports_browse)).toBe(true);

		expect(
			makeIntegrations(
				{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'off' },
				new MemoryBucket(),
			).dataBrowser,
		).toBeUndefined();

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

	it('keeps Run SQL off by default and exposes an explicitly injected isolated service', async () => {
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
		const wired = makeIntegrations(env, new MemoryBucket(), undefined, undefined, dataQuery);
		expect(wired.dataBrowser?.query).toBe(true);
		const pid = createProjectId();
		const created = await wired.integrations?.create(
			pid,
			{ kind: 'custom_env', name: 'source', config: { vars: { SOURCE: 'test' } } },
			ACTOR,
		);
		await expect(
			wired.integrations?.runDataQuery(
				pid,
				created!.id,
				{ userId: ACTOR, email: 'actor@example.com' },
				createSessionId(),
				'select 1',
			),
		).resolves.toEqual({ columns: ['value'], rows: [[1]], truncated: false });
		expect(executions).toHaveLength(1);
		await wired.dataBrowser?.close?.();
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

	it('refuses to enable browsing without integrations', () => {
		expect(() =>
			makeIntegrations({ MARIMOHUB_DATA_BROWSER: 'metadata' }, new MemoryBucket()),
		).toThrow(/MARIMOHUB_INTEGRATIONS=on/);
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
