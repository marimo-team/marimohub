import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../errors';
import type { IntegrationProbe } from '../../ports/integrations';
import { trino } from './kinds/trino';
import {
	basicAuthHeader,
	defineIntegration,
	envSegment,
	pageByNameCursor,
	probeErrorDetails,
} from './sdk';
import { zSecret } from './secretFields';

/** Fails the request with a message that quotes whatever the kind sent. */
function echoingProbe(): IntegrationProbe {
	return {
		connect: () => Promise.reject(new Error('unused')),
		fetch: (_url, init) =>
			Promise.reject(new Error(`invalid header value ${JSON.stringify(init?.headers ?? {})}`)),
	};
}

/** For kinds that fail before (or without) touching the network. */
function unusedProbe(): IntegrationProbe {
	return {
		connect: () => Promise.reject(new Error('unused')),
		fetch: () => Promise.reject(new Error('unused')),
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

	it('redacts a JSON-escaped header secret quoted back by the transport', async () => {
		const secret = 'he"llo\\wor\tld\tx';
		const config = trino.configSchema.parse({
			host: 'trino.internal',
			auth: { method: 'none' },
			http_headers: [{ name: 'X-Tenant', value: secret }],
		});

		const result = await trino.testConnection?.(config, echoingProbe());

		expect(result?.ok).toBe(false);
		expect(result?.details).not.toContain('llo');
		expect(result?.details).toBe('request failed');
	});

	// A CR/LF in a header value is a header-injection vector, so the guard rejects
	// it with a ValidationError (422) rather than letting it reach the transport.
	it('rejects a header value carrying a line break', async () => {
		const config = trino.configSchema.parse({
			host: 'trino.internal',
			auth: { method: 'none' },
			http_headers: [{ name: 'X-Tenant', value: 'tenant\r\nX-Injected: 1' }],
		});

		await expect(trino.testConnection?.(config, unusedProbe())).rejects.toThrow(ValidationError);
	});

	// A JSON config can carry a lone surrogate, which encodeURIComponent rejects;
	// the guard must still redact rather than throw the URIError out as a 500.
	it('redacts a secret that cannot be URL-encoded', async () => {
		const secret = 'tok\ud800en';
		const config = trino.configSchema.parse({
			host: 'trino.internal',
			auth: { method: 'none' },
			http_headers: [{ name: 'X-Tenant', value: secret }],
		});

		const result = await trino.testConnection?.(config, echoingProbe());

		expect(result?.details).toBe('request failed');
	});

	it('redacts a secret nested under an array path and a URL-encoded echo', async () => {
		const secret = 'extra credential/value';
		const def = defineIntegration({
			kind: 'guard_fixture',
			title: 'Guard fixture',
			description: 'Test double',
			category: 'engine',
			brand: { color: '#000000' },
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

		const result = await def.testConnection?.(
			{ items: [{ name: 'a', value: secret }] },
			unusedProbe(),
		);

		expect(result?.details).toBe('request failed');
	});

	it('converts a throw that quotes a secret into a redacted failure', async () => {
		const secret = 'thrown-token-value';
		const def = defineIntegration({
			kind: 'throwing_fixture',
			title: 'Throwing fixture',
			description: 'Test double',
			category: 'engine',
			brand: { color: '#000000' },
			schemaVersion: 1,
			configSchema: z.object({ token: zSecret() }),
			render: () => ({}),
			testConnection: (config) => {
				throw new Error(`connect failed: authorization=Bearer ${config.token}`);
			},
		});

		const result = await def.testConnection?.({ token: secret }, unusedProbe());

		expect(result).toEqual({ ok: false, details: 'request failed' });
	});

	it('drops the message of an escaped throw even when no secret is quoted', async () => {
		const def = defineIntegration({
			kind: 'throwing_fixture',
			title: 'Throwing fixture',
			description: 'Test double',
			category: 'engine',
			brand: { color: '#000000' },
			schemaVersion: 1,
			configSchema: z.object({ token: zSecret() }),
			render: () => ({}),
			testConnection: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:8080')),
		});

		const result = await def.testConnection?.({ token: 'unused' }, unusedProbe());

		expect(result?.details).toBe('request failed');
	});

	it('propagates a ValidationError so the route still answers 422', async () => {
		const def = defineIntegration({
			kind: 'rejecting_fixture',
			title: 'Rejecting fixture',
			description: 'Test double',
			category: 'engine',
			brand: { color: '#000000' },
			schemaVersion: 1,
			configSchema: z.object({ token: zSecret() }),
			render: () => ({}),
			testConnection: () => Promise.reject(new ValidationError('unsupported auth combination')),
		});

		await expect(def.testConnection?.({ token: 'unused' }, unusedProbe())).rejects.toThrow(
			ValidationError,
		);
	});

	it('keeps a redacted success from contradicting its own ok result', async () => {
		const probe: IntegrationProbe = {
			connect: () => Promise.reject(new Error('unused')),
			fetch: () =>
				Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve({ nodeVersion: { version: '444' } }),
				}),
		};
		// A two-character password is a substring of the success detail "Trino 444".
		const config = trino.configSchema.parse({
			host: 'trino.internal',
			auth: { method: 'basic', username: 'svc', password: '44' },
		});

		const result = await trino.testConnection?.(config, probe);

		expect(result?.ok).toBe(true);
		expect(result?.details).toBe('connected');
		expect(result?.details).not.toContain('44');
	});

	it('leaves secret-free details (status codes, versions) untouched', async () => {
		const probe: IntegrationProbe = {
			connect: () => Promise.reject(new Error('unused')),
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

	it('pages sorted unique names with an opaque keyset cursor', () => {
		const first = pageByNameCursor(
			['delta', 'alpha', 'beta', 'beta'],
			{ limit: 2 },
			(item) => item,
		);
		expect(first).toEqual({ items: ['alpha', 'beta'], next_cursor: 'name:beta' });
		expect(
			pageByNameCursor(
				['aardvark', 'beta', 'delta', 'epsilon'],
				{ limit: 2, cursor: first.next_cursor! },
				(item) => item,
			),
		).toEqual({ items: ['delta', 'epsilon'], next_cursor: null });
	});

	it('encodes name cursors and rejects malformed cursors', () => {
		const first = pageByNameCursor(['a name', 'z'], { limit: 1 }, (item) => item);
		expect(first.next_cursor).toBe('name:a%20name');
		expect(() => pageByNameCursor(['a'], { limit: 1, cursor: 'offset:1' }, (item) => item)).toThrow(
			'Invalid browse cursor.',
		);
		expect(() =>
			pageByNameCursor(['a'], { limit: 1, cursor: 'name:%E0%A4%A' }, (item) => item),
		).toThrow('Invalid browse cursor.');
	});
});

describe('defineIntegration browse guard', () => {
	const browsy = defineIntegration({
		kind: 'browsy',
		title: 'Browsy',
		description: 'test kind',
		category: 'catalog',
		brand: { color: '#000000' },
		schemaVersion: 1,
		configSchema: z.object({ token: zSecret() }),
		render: () => ({}),
		browse: {
			available: () => ({ ok: true }),
			async listNamespaces(_config, probe) {
				await probe.fetch('https://catalog.example/v1/namespaces');
				return { items: [], next_cursor: null };
			},
			async listTables(config) {
				throw new ValidationError(`catalog denied access for ${config.token}`);
			},
			async getTableSchema() {
				throw new NotFoundError('The catalog reports no such namespace or table.');
			},
			snippet: () => 'code',
		},
	});
	const config = { token: 'sekret-value' };

	it('replaces a thrown transport error with a generic failure', async () => {
		const probe: IntegrationProbe = {
			connect: () => Promise.reject(new Error('unused')),
			fetch: () => Promise.reject(new Error(`401 for Bearer ${config.token}`)),
		};
		await expect(browsy.browse!.listNamespaces(config, probe, { limit: 10 })).rejects.toThrow(
			'The catalog request failed.',
		);
	});

	it('passes a clean DomainError through untouched', async () => {
		await expect(browsy.browse!.getTableSchema(config, unusedProbe(), [], 't')).rejects.toThrow(
			'The catalog reports no such namespace or table.',
		);
	});

	it('degrades a DomainError whose message quotes a secret value', async () => {
		await expect(
			browsy.browse!.listTables(config, unusedProbe(), [], { limit: 10 }),
		).rejects.toThrow('The catalog request failed.');
	});
});

describe('defineIntegration available-reason guard', () => {
	const leaky = defineIntegration({
		kind: 'leaky',
		title: 'Leaky',
		description: 'test kind',
		category: 'catalog',
		brand: { color: '#000000' },
		schemaVersion: 1,
		configSchema: z.object({ token: zSecret() }),
		render: () => ({}),
		browse: {
			// A kind must never do this; the guard is the backstop.
			available: (config) => ({ ok: false, reason: `denied for ${config.token}` }),
			listNamespaces: async () => ({ items: [], next_cursor: null }),
			listTables: async () => ({ items: [], next_cursor: null }),
			getTableSchema: async () => ({ columns: [] }),
			snippet: () => 'code',
		},
	});

	it('degrades a capability reason that quotes a secret value', () => {
		const verdict = leaky.browse!.available({ token: 'sekret-value' });
		expect(verdict).toEqual({
			ok: false,
			reason: 'this instance cannot be browsed from the hub',
		});
	});

	it('degrades a preview reason that quotes a secret value', () => {
		const previewLeaky = defineIntegration({
			kind: 'preview_leaky',
			title: 'Preview leaky',
			description: 'test kind',
			category: 'catalog',
			brand: { color: '#000000' },
			schemaVersion: 1,
			configSchema: z.object({ token: zSecret() }),
			render: () => ({}),
			preview: {
				available: (config) => ({ ok: false, reason: `preview denied for ${config.token}` }),
				programs: () => ({}),
			},
		});

		expect(previewLeaky.preview!.available({ token: 'preview-secret' })).toEqual({
			ok: false,
			reason: 'this instance cannot be previewed from the hub',
		});
	});

	it('preserves a preview reason that does not contain a secret', () => {
		const previewBlocked = defineIntegration({
			kind: 'preview_blocked',
			title: 'Preview blocked',
			description: 'test kind',
			category: 'catalog',
			brand: { color: '#000000' },
			schemaVersion: 1,
			configSchema: z.object({ token: zSecret() }),
			render: () => ({}),
			preview: {
				available: () => ({ ok: false, reason: 'preview requires supported authentication' }),
				programs: () => ({}),
			},
		});

		expect(previewBlocked.preview!.available({ token: 'preview-secret' })).toEqual({
			ok: false,
			reason: 'preview requires supported authentication',
		});
	});

	it('guards query availability reasons and plan failures that echo secrets', () => {
		const queryLeaky = defineIntegration({
			kind: 'query_leaky',
			title: 'Query leaky',
			description: 'test kind',
			category: 'catalog',
			brand: { color: '#000000' },
			schemaVersion: 1,
			configSchema: z.object({ token: zSecret() }),
			render: () => ({}),
			query: {
				readiness: (config) => [
					{
						id: 'secret-check',
						label: `Remove ${String((config as { token?: unknown }).token)}`,
						ready: false,
						field: String((config as { token?: unknown }).token),
						reason: `query denied for ${String((config as { token?: unknown }).token)}`,
					},
				],
				available: (config) => ({ ok: false, reason: `query denied for ${config.token}` }),
				plan: ({ config }) => {
					throw new ValidationError(`bad plan for ${encodeURIComponent(config.token)}`);
				},
			},
		});

		expect(queryLeaky.query!.available({ token: 'query secret/value' })).toEqual({
			ok: false,
			reason: 'this instance cannot run SQL from the hub',
		});
		expect(queryLeaky.query!.readiness?.({ token: 'query secret/value' })).toEqual([
			{
				id: 'secret-check',
				label: 'Meet the SQL configuration requirements',
				ready: false,
				field: '',
				reason: 'this configuration cannot run SQL from the hub',
			},
		]);
		expect(() =>
			queryLeaky.query!.plan({
				config: { token: 'query secret/value' },
				integration: {
					id: 'intg-0000000000000000' as never,
					name: 'query',
					kind: 'query_leaky',
					version: 1,
				},
			}),
		).toThrow('The integration query plan could not be created.');
	});

	it('degrades unexpected query availability failures to an unavailable verdict', () => {
		const queryUnavailable = defineIntegration({
			kind: 'query_unavailable',
			title: 'Query unavailable',
			description: 'test kind',
			category: 'catalog',
			brand: { color: '#000000' },
			schemaVersion: 1,
			configSchema: z.object({ token: zSecret() }),
			render: () => ({}),
			query: {
				available: () => {
					throw new Error('kind implementation failed');
				},
				plan: () => ({ setup: [] }),
			},
		});

		expect(queryUnavailable.query!.available({ token: 'query-secret' })).toEqual({
			ok: false,
			reason: 'this instance cannot run SQL from the hub',
		});
	});

	it('preserves deliberate query availability rejections', () => {
		const queryRejected = defineIntegration({
			kind: 'query_rejected',
			title: 'Query rejected',
			description: 'test kind',
			category: 'catalog',
			brand: { color: '#000000' },
			schemaVersion: 1,
			configSchema: z.object({ token: zSecret() }),
			render: () => ({}),
			query: {
				available: () => {
					throw new ValidationError('invalid query configuration');
				},
				plan: () => ({ setup: [] }),
			},
		});

		expect(() => queryRejected.query!.available({ token: 'query-secret' })).toThrow(
			'invalid query configuration',
		);
	});
});
