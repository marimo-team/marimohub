import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { IntegrationProbe } from '../../ports/integrations';
import { trino } from './kinds/trino';
import { basicAuthHeader, defineIntegration, envSegment, probeErrorDetails } from './sdk';
import { zSecret } from './secretFields';

/** Fails the request with a message that quotes whatever the kind sent. */
function echoingProbe(): IntegrationProbe {
	return {
		fetch: (_url, init) =>
			Promise.reject(new Error(`invalid header value ${JSON.stringify(init?.headers ?? {})}`)),
	};
}

describe('defineIntegration secret guard', () => {
	it('redacts a header secret an auth-none Trino test would echo', async () => {
		const secret = 'header-secret-value';
		const config = trino.configSchema.parse({
			host: 'trino.internal',
			auth: { method: 'none' },
			http_headers: [{ name: 'X-Tenant', value: secret }],
		});

		const result = await trino.testConnection?.(config, echoingProbe());

		expect(result?.ok).toBe(false);
		expect(result?.details).not.toContain(secret);
		expect(result?.details).toBe('request failed');
	});

	it('redacts a secret nested under an array path and a URL-encoded echo', async () => {
		const secret = 'extra credential/value';
		const def = defineIntegration({
			kind: 'guard_fixture',
			title: 'Guard fixture',
			description: 'Test double',
			category: 'engine',
			schemaVersion: 1,
			configSchema: z.object({
				items: z.array(z.object({ name: z.string(), value: zSecret() })),
			}),
			render: () => ({}),
			testConnection: (config) =>
				Promise.resolve({
					ok: false,
					details: `upstream said ${encodeURIComponent(config.items[0].value)}`,
				}),
		});

		const result = await def.testConnection?.({ items: [{ name: 'a', value: secret }] }, {
			fetch: () => Promise.reject(new Error('unused')),
		} as IntegrationProbe);

		expect(result?.details).toBe('request failed');
	});

	it('leaves secret-free details (status codes, versions) untouched', async () => {
		const probe: IntegrationProbe = {
			fetch: () =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ nodeVersion: { version: '444' } }),
				}),
		};
		const config = trino.configSchema.parse({
			host: 'trino.internal',
			auth: { method: 'basic', username: 'svc', password: 'pw-not-echoed' },
			http_headers: [{ name: 'X-Tenant', value: 'header-secret-value' }],
		});

		const result = await trino.testConnection?.(config, probe);

		expect(result).toMatchObject({ ok: true, details: 'Trino 444' });
	});
});

describe('sdk helpers', () => {
	it('probeErrorDetails suppresses the message for credential-carrying requests', () => {
		expect(probeErrorDetails(new Error('connect ECONNREFUSED'), false)).toBe(
			'connect ECONNREFUSED',
		);
		expect(probeErrorDetails(new Error('connect ECONNREFUSED'), true)).toBe('request failed');
		expect(probeErrorDetails('not an error', false)).toBe('request failed');
	});

	it('encodes non-Latin-1 basic credentials and normalizes env segments', () => {
		expect(basicAuthHeader('césar', 'pässwörd')).toBe('Basic Y8Opc2FyOnDDpHNzd8O2cmQ=');
		expect(envSegment('my-warehouse')).toBe('MY_WAREHOUSE');
	});
});
