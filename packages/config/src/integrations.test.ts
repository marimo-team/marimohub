import { describe, expect, it } from 'vitest';
import { createProjectId } from '@marimo-hub/core';
import { ACTOR, MemoryBucket } from '@marimo-hub/core/testing';
import { ConfigError } from './errors';
import { makeIntegrations } from './integrations';

const PG_CONFIG = { host: 'db.internal', database: 'db', username: 'u', password: 'pw' };

describe('makeIntegrations', () => {
	it('is OPT-IN (two-phase rollout): unset/off disabled, on enabled', () => {
		expect(makeIntegrations({}, new MemoryBucket())).toEqual({});
		expect(makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'off' }, new MemoryBucket())).toEqual({});
		expect(makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'none' }, new MemoryBucket())).toEqual({});
		expect(
			makeIntegrations({ MARIMOHUB_INTEGRATIONS: 'on' }, new MemoryBucket()).integrations,
		).toBeDefined();
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
			{ MARIMOHUB_INTEGRATIONS: 'on', MARIMOHUB_SECRETS_KEK: 'k'.repeat(32) },
			new MemoryBucket(),
		).integrations;
		const detail = await withKek?.create(pid, input, ACTOR);
		expect(detail?.config.password).toEqual({ $secret: { set: true } });
	});
});
