import { describe, expect, it, vi } from 'vitest';
import { ProjectId, SecretResolutionError } from '@marimo-hub/core';
import type { SecretResolutionContext } from '@marimo-hub/core';
import {
	INTEGRATION_SECRET_LABEL,
	KubernetesSecretResolver,
	parseKubernetesSecretLocator,
} from './index';
import type {
	KubernetesSecretFetcher,
	KubernetesSecretPolicy,
	KubernetesSecretSnapshot,
} from './index';

const PROJECT_A = ProjectId.parse('proj-0000000000000000');
const PROJECT_B = ProjectId.parse('proj-1111111111111111');
const DEFAULT_POLICIES: KubernetesSecretPolicy[] = [
	{ namespace: 'connections', name: 'provider', projects: '*' },
	{ namespace: 'other', name: 'other-provider', projects: '*' },
];
const projectContext = (projectId = PROJECT_A): SecretResolutionContext => ({
	scope: 'project',
	projectId,
});
const orgContext = (): SecretResolutionContext => ({ scope: 'org' });
const ref = (locator: string) => ({ backend: 'k8s', locator });
const encoded = (value: string) => Buffer.from(value).toString('base64');

function secret(
	data: Record<string, string> = { token: encoded('resolved') },
): KubernetesSecretSnapshot {
	return {
		metadata: { labels: { [INTEGRATION_SECRET_LABEL]: 'true' } },
		data,
	};
}

function resolver(
	fetch: KubernetesSecretFetcher,
	cacheTtlMs = 0,
	now?: () => number,
	allowedSecrets: readonly KubernetesSecretPolicy[] = DEFAULT_POLICIES,
) {
	return new KubernetesSecretResolver({ fetch, allowedSecrets, cacheTtlMs, now });
}

describe('parseKubernetesSecretLocator', () => {
	it('parses an explicit namespace, DNS subdomain name, and data key', () => {
		expect(parseKubernetesSecretLocator('connections/provider.example#access_key')).toEqual({
			namespace: 'connections',
			name: 'provider.example',
			key: 'access_key',
		});
	});

	it.each([
		'',
		'provider#key',
		'connections/provider',
		'connections/provider#',
		'/provider#key',
		'connections//provider#key',
		'Connections/provider#key',
		'connections/-provider#key',
		'connections/provider..example#key',
		`connections/${'a'.repeat(64)}#key`,
		`connections/${'a'.repeat(250)}.name#key`,
		`connections/provider#${'a'.repeat(254)}`,
		'connections/provider#bad/key',
		'connections/provider#bad key',
		'connections/provider#key#other',
	])('rejects malformed locator %j without echoing it', (locator) => {
		let error: unknown;
		try {
			parseKubernetesSecretLocator(locator);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(SecretResolutionError);
		expect(error).toMatchObject({ reason: 'invalid_value' });
		if (locator) expect(String(error)).not.toContain(locator);
	});
});

describe('KubernetesSecretResolver policy', () => {
	it('rejects empty policy configuration', () => {
		expect(() => resolver(async () => secret(), 0, undefined, [])).toThrow(/non-empty JSON array/);
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid cache TTL %j', (ttl) => {
		expect(() => resolver(async () => secret(), ttl)).toThrow(/non-negative safe integer/);
	});

	it('rejects an unlisted Secret before making an API request', async () => {
		const fetch = vi.fn(async () => secret());
		await expect(
			resolver(fetch).resolve(ref('connections/unlisted#token'), projectContext()),
		).rejects.toMatchObject({ reason: 'forbidden' });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('matches the namespace and Secret name together', async () => {
		const fetch = vi.fn(async () => secret());
		await expect(
			resolver(fetch).resolve(ref('other/provider#token'), projectContext()),
		).rejects.toMatchObject({ reason: 'forbidden' });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('authorizes only listed projects before fetching', async () => {
		const fetch = vi.fn(async () => secret());
		const policies = [{ namespace: 'connections', name: 'provider', projects: [PROJECT_A] }];
		const r = resolver(fetch, 0, undefined, policies);
		await expect(
			r.resolve(ref('connections/provider#token'), projectContext(PROJECT_A)),
		).resolves.toBe('resolved');
		await expect(
			r.resolve(ref('connections/provider#token'), projectContext(PROJECT_B)),
		).rejects.toMatchObject({ reason: 'forbidden' });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('requires wildcard authorization for organization integrations', async () => {
		const fetch = vi.fn(async () => secret());
		const restricted = resolver(fetch, 0, undefined, [
			{ namespace: 'connections', name: 'provider', projects: [PROJECT_A] },
		]);
		await expect(
			restricted.resolve(ref('connections/provider#token'), orgContext()),
		).rejects.toMatchObject({ reason: 'forbidden' });
		expect(fetch).not.toHaveBeenCalled();

		const wildcard = resolver(fetch);
		await expect(wildcard.resolve(ref('connections/provider#token'), orgContext())).resolves.toBe(
			'resolved',
		);
	});
});

describe('KubernetesSecretResolver values and metadata', () => {
	it('resolves non-empty base64 UTF-8 data', async () => {
		const value = 'påssword';
		const result = await resolver(async () => secret({ token: encoded(value) })).resolve(
			ref('connections/provider#token'),
			projectContext(),
		);
		expect(result).toBe(value);
	});

	it.each([
		['missing label', { metadata: {} }],
		['wrong label', { metadata: { labels: { [INTEGRATION_SECRET_LABEL]: 'false' } } }],
		['missing metadata', {}],
	] as const)('fails closed for %s', async (_name, metadata) => {
		await expect(
			resolver(async () => ({ ...metadata, data: { token: encoded('value') } })).resolve(
				ref('connections/provider#token'),
				projectContext(),
			),
		).rejects.toMatchObject({ reason: 'forbidden' });
	});

	it('does not require annotations on an opted-in Secret', async () => {
		await expect(
			resolver(async () => secret()).resolve(ref('connections/provider#token'), projectContext()),
		).resolves.toBe('resolved');
	});

	it('supports many exact Secrets across namespaces', async () => {
		const policies: KubernetesSecretPolicy[] = [
			{ namespace: 'connections', name: 'provider-a', projects: '*' },
			{ namespace: 'other', name: 'provider-b', projects: [PROJECT_A, PROJECT_B] },
		];
		const r = resolver(
			async (_namespace, name) => secret({ token: encoded(name) }),
			0,
			undefined,
			policies,
		);
		await expect(r.resolve(ref('connections/provider-a#token'), projectContext())).resolves.toBe(
			'provider-a',
		);
		await expect(r.resolve(ref('other/provider-b#token'), projectContext())).resolves.toBe(
			'provider-b',
		);
	});

	it.each([
		['missing', {}],
		['empty', { token: '' }],
		['non-canonical base64', { token: 'abc' }],
		['base64 with whitespace', { token: 'dmFs dWU=' }],
		['URL-safe base64', { token: '__8=' }],
		['non-canonical padding bits', { token: '//==' }],
		['invalid UTF-8', { token: '/w==' }],
	] as const)('rejects %s secret data', async (_name, data) => {
		const r = resolver(async () => secret(data));
		await expect(
			r.resolve(ref('connections/provider#token'), projectContext()),
		).rejects.toMatchObject({ reason: 'invalid_value' });
	});

	it('does not include identifiers or decoded values in failures', async () => {
		const locator = 'connections/provider#private-key';
		const value = 'do-not-leak';
		const invalid = await resolver(async () => ({
			data: { 'private-key': encoded(value) },
		}))
			.resolve(ref(locator), projectContext())
			.catch((caught: unknown) => caught);
		expect(String(invalid)).not.toContain(locator);
		expect(String(invalid)).not.toContain('provider');
		expect(String(invalid)).not.toContain('private-key');
		expect(String(invalid)).not.toContain(value);
	});
});

describe('KubernetesSecretResolver caching', () => {
	it('uses one snapshot for sibling keys in one operation', async () => {
		let generation = 0;
		const fetch = vi.fn(async () => {
			generation++;
			return secret({
				access: encoded(`access-${generation}`),
				secret: encoded(`secret-${generation}`),
			});
		});
		const r = resolver(fetch);
		const context = projectContext();
		await expect(r.resolve(ref('connections/provider#access'), context)).resolves.toBe('access-1');
		await expect(r.resolve(ref('connections/provider#secret'), context)).resolves.toBe('secret-1');
		expect(fetch).toHaveBeenCalledTimes(1);
		await expect(r.resolve(ref('connections/provider#access'), projectContext())).resolves.toBe(
			'access-2',
		);
	});

	it('coalesces concurrent reads for sibling keys', async () => {
		const fetch = vi.fn(async () => secret({ access: encoded('a'), secret: encoded('b') }));
		const r = resolver(fetch);
		const context = projectContext();
		await expect(
			Promise.all([
				r.resolve(ref('connections/provider#access'), context),
				r.resolve(ref('connections/provider#secret'), context),
			]),
		).resolves.toEqual(['a', 'b']);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('reads afresh across operations when the TTL is zero', async () => {
		const fetch = vi.fn(async () => secret());
		const r = resolver(fetch);
		await r.resolve(ref('connections/provider#token'), projectContext());
		await r.resolve(ref('connections/provider#token'), projectContext());
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('shares a successful TTL entry across operations and expires it at the boundary', async () => {
		let now = 100;
		const fetch = vi.fn(async () => secret());
		const r = resolver(fetch, 50, () => now);
		await r.resolve(ref('connections/provider#token'), projectContext());
		now = 149;
		await r.resolve(ref('connections/provider#token'), projectContext());
		expect(fetch).toHaveBeenCalledTimes(1);
		now = 150;
		await r.resolve(ref('connections/provider#token'), projectContext());
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('rechecks the opt-in label when a cached snapshot is reused', async () => {
		const snapshot = secret();
		const fetch = vi.fn(async () => snapshot);
		const r = resolver(fetch, 1000);
		await r.resolve(ref('connections/provider#token'), projectContext());
		snapshot.metadata = { labels: { [INTEGRATION_SECRET_LABEL]: 'false' } };
		await expect(
			r.resolve(ref('connections/provider#token'), projectContext()),
		).rejects.toMatchObject({ reason: 'forbidden' });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('does not cache API failures', async () => {
		const fetch = vi
			.fn<KubernetesSecretFetcher>()
			.mockRejectedValueOnce({ code: 503 })
			.mockResolvedValueOnce(secret());
		const r = resolver(fetch, 1000);
		const context = projectContext();
		await expect(r.resolve(ref('connections/provider#token'), context)).rejects.toMatchObject({
			reason: 'unavailable',
		});
		await expect(r.resolve(ref('connections/provider#token'), context)).resolves.toBe('resolved');
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('does not cache snapshots that fail validation', async () => {
		const fetch = vi
			.fn<KubernetesSecretFetcher>()
			.mockResolvedValueOnce({ data: { token: encoded('value') } })
			.mockResolvedValueOnce(secret());
		const r = resolver(fetch, 1000);
		await expect(
			r.resolve(ref('connections/provider#token'), projectContext()),
		).rejects.toMatchObject({ reason: 'forbidden' });
		await expect(r.resolve(ref('connections/provider#token'), projectContext())).resolves.toBe(
			'resolved',
		);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

describe('KubernetesSecretResolver API errors', () => {
	it.each([
		[{ code: 404 }, 'not_found'],
		[{ statusCode: 401 }, 'forbidden'],
		[{ body: { code: 403 } }, 'forbidden'],
		[{ code: 429 }, 'unavailable'],
		[{ statusCode: 503 }, 'unavailable'],
		[new Error('provider sensitive-key'), 'unavailable'],
	] as const)('maps Kubernetes error %# without leaking identifiers', async (failure, reason) => {
		const locator = 'connections/provider#sensitive-key';
		const r = resolver(async () => {
			throw failure instanceof Error
				? failure
				: Object.assign(new Error('provider sensitive-key'), failure);
		});
		const error = await r
			.resolve(ref(locator), projectContext())
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ reason });
		expect(String(error)).not.toContain(locator);
		expect(String(error)).not.toContain('provider');
		expect(String(error)).not.toContain('sensitive-key');
	});
});
