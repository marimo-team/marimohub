import { describe, expect, it } from 'vitest';
import { ConfigError } from './errors';
import { parsePublicAppsConfig } from './publicApps';

const SECRET = 'a-very-long-public-apps-signing-secret-32+';

describe('parsePublicAppsConfig', () => {
	it('defaults to disabled when unset or off', () => {
		expect(
			parsePublicAppsConfig({}, { authBackend: 'oidc', exposureMode: 'subdomain' }),
		).toBeUndefined();
		expect(
			parsePublicAppsConfig(
				{ MARIMOHUB_PUBLIC_APP_LINKS: 'off' },
				{ authBackend: 'oidc', exposureMode: 'subdomain' },
			),
		).toBeUndefined();
	});

	it('parses bounded defaults and falls back to MARIMOHUB_AUTH_SESSION_SECRET', () => {
		const cfg = parsePublicAppsConfig(
			{
				MARIMOHUB_PUBLIC_APP_LINKS: 'on',
				MARIMOHUB_AUTH_SESSION_SECRET: SECRET,
			},
			{ authBackend: 'oidc', exposureMode: 'subdomain' },
		);
		expect(cfg).toBeDefined();
		expect(cfg!.signingSecret).toBe(SECRET);
		expect(cfg!.allowProjectIntegrations).toBe(false);
		expect(cfg!.maxConcurrentSessions).toBe(10);
		expect(cfg!.poolPolicy.maxSessionsPerVersion).toBe(2);
		expect(cfg!.poolPolicy.maxVisitsPerSession).toBe(25);
		expect(cfg!.idleTimeoutMs).toBe(300_000);
		expect(cfg!.maxLifetimeMs).toBe(3_600_000);
		expect(cfg!.visitTokenTtlSeconds).toBe(600);
	});

	it('enables project integration opt-in when configured', () => {
		const cfg = parsePublicAppsConfig(
			{
				MARIMOHUB_PUBLIC_APP_LINKS: 'on',
				MARIMOHUB_PUBLIC_APPS_ALLOW_INTEGRATIONS: 'on',
				MARIMOHUB_PUBLIC_APPS_SECRET: SECRET,
			},
			{ authBackend: 'oidc', exposureMode: 'proxy' },
		);
		expect(cfg?.allowProjectIntegrations).toBe(true);
	});

	it('refuses missing/short signing secret and unlimited (0) caps', () => {
		expect(() =>
			parsePublicAppsConfig(
				{ MARIMOHUB_PUBLIC_APP_LINKS: 'on' },
				{ authBackend: 'oidc', exposureMode: 'subdomain' },
			),
		).toThrow(ConfigError);
		expect(() =>
			parsePublicAppsConfig(
				{
					MARIMOHUB_PUBLIC_APP_LINKS: 'on',
					MARIMOHUB_PUBLIC_APPS_SECRET: SECRET,
					MARIMOHUB_PUBLIC_APPS_MAX_CONCURRENT_SESSIONS: '0',
				},
				{ authBackend: 'oidc', exposureMode: 'subdomain' },
			),
		).toThrow(ConfigError);
	});

	it('refuses proxy-header and cloudflare-access in proxy mode and requires ack in subdomain mode', () => {
		for (const authBackend of ['proxy-header', 'cloudflare-access']) {
			expect(() =>
				parsePublicAppsConfig(
					{
						MARIMOHUB_PUBLIC_APP_LINKS: 'on',
						MARIMOHUB_PUBLIC_APPS_SECRET: SECRET,
						MARIMOHUB_PUBLIC_APPS_EDGE_BYPASS_ACK: 'true',
					},
					{ authBackend, exposureMode: 'proxy' },
				),
			).toThrow(ConfigError);

			expect(() =>
				parsePublicAppsConfig(
					{
						MARIMOHUB_PUBLIC_APP_LINKS: 'on',
						MARIMOHUB_PUBLIC_APPS_SECRET: SECRET,
					},
					{ authBackend, exposureMode: 'subdomain' },
				),
			).toThrow(ConfigError);

			expect(
				parsePublicAppsConfig(
					{
						MARIMOHUB_PUBLIC_APP_LINKS: 'on',
						MARIMOHUB_PUBLIC_APPS_SECRET: SECRET,
						MARIMOHUB_PUBLIC_APPS_EDGE_BYPASS_ACK: 'true',
					},
					{ authBackend, exposureMode: 'subdomain' },
				),
			).toBeDefined();
		}
	});
});
