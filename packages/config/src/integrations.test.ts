import { describe, expect, it } from 'vitest';
import { createProjectId } from '@marimo-hub/core';
import { ACTOR, MemoryBucket } from '@marimo-hub/core/testing';
import { ConfigError } from './errors';
import { makeIntegrations, objectBrowserDeadlinesFromEnv } from './integrations';

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
		expect(wired.dataBrowser).toEqual({ preview: false });
		expect(wired.integrations?.listKinds().some((k) => k.supports_browse)).toBe(true);
		expect(wired.integrations?.listKinds().find((kind) => kind.kind === 's3')).toMatchObject({
			supports_browse: true,
			browse_surfaces: ['objects'],
		});

		const full = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'full' },
			new MemoryBucket(),
		);
		expect(full.dataBrowser).toEqual({ preview: true });
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
					MARIMOHUB_DATA_PREVIEW_EXECUTION_TIMEOUT_SECONDS: 'stale-invalid-value',
				},
				new MemoryBucket(),
			),
		).not.toThrow();
		expect(
			objectBrowserDeadlinesFromEnv(
				{ MARIMOHUB_DATA_PREVIEW_EXECUTION_TIMEOUT_SECONDS: 'stale-invalid-value' },
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
				{ MARIMOHUB_DATA_PREVIEW_EXECUTION_TIMEOUT_SECONDS: '45' },
				'full',
			),
		).toEqual({
			metadataTimeoutMs: 30_000,
			previewTimeoutMs: 45_000,
			resolveTimeoutMs: 45_000,
		});
		expect(
			objectBrowserDeadlinesFromEnv(
				{ MARIMOHUB_DATA_PREVIEW_EXECUTION_TIMEOUT_SECONDS: '5' },
				'full',
			),
		).toEqual({
			metadataTimeoutMs: 30_000,
			previewTimeoutMs: 5_000,
			resolveTimeoutMs: 30_000,
		});
	});

	it('does not add a generic sandbox fallback unless a runtime is explicitly wired', () => {
		const runtime = {
			available: () => false,
			check: async () => {},
			preview: async () => ({ columns: [], rows: [] }),
		};
		const without = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'full' },
			new MemoryBucket(),
		);
		expect(without.dataBrowser?.sandboxPreview).toBeUndefined();
		const withRuntime = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'full' },
			new MemoryBucket(),
			undefined,
			runtime,
		);
		expect(withRuntime.dataBrowser?.sandboxPreview).toBe(runtime);
	});

	it('passes metadata and full modes to the production S3 browser', async () => {
		for (const [mode, expected] of [
			['metadata', { preview: false, download: false }],
			['full', { preview: true, download: true }],
		] as const) {
			const integrations = makeIntegrations(
				{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: mode },
				new MemoryBucket(),
			).integrations!;
			const pid = createProjectId();
			const created = await integrations.create(
				pid,
				{ kind: 's3', name: `s3-${mode}`, config: { auth: { method: 'ambient' } } },
				ACTOR,
			);
			const capability = await integrations.browseCapability(pid, created.id, {
				project_id: pid,
				user_id: ACTOR,
				user_email: 'user@example.com',
				allow_server_ambient: true,
			});
			expect(capability.surfaces.objects).toMatchObject({ available: true, ...expected });
		}
	});

	it('advertises sandbox fallback only after its runtime becomes available', async () => {
		let available = false;
		const runtime = {
			available: () => available,
			check: async () => {
				available = true;
			},
			preview: async () => ({ columns: [], rows: [] }),
		};
		const wired = makeIntegrations(
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_DATA_BROWSER: 'full' },
			new MemoryBucket(),
			undefined,
			runtime,
		);
		expect(wired.dataBrowser?.sandboxPreview?.available()).toBe(false);
		await wired.dataBrowser?.sandboxPreview?.check();
		expect(wired.dataBrowser?.sandboxPreview?.available()).toBe(true);
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

	it('rejects invalid full-preview operation deadlines', () => {
		for (const value of ['0', '-1', 'not-a-number', '2147484']) {
			expect(() =>
				makeIntegrations(
					{
						MARIMOHUB_INTEGRATIONS: 'on',
						MARIMOHUB_DATA_BROWSER: 'full',
						MARIMOHUB_DATA_PREVIEW_EXECUTION_TIMEOUT_SECONDS: value,
					},
					new MemoryBucket(),
				),
			).toThrow(/expected .*integer/);
		}
	});
});
