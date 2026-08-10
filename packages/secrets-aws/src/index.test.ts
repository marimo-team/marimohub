import { describe, it, expect, vi } from 'vitest';
import { SecretResolutionError } from '@marimo-hub/core';
import { AwsSecretsManagerResolver } from './index';
import type { GetSecretValueResult, SecretFetcher } from './index';

const SECRET = 'sk-live-do-not-log';

function resolver(fetch: SecretFetcher, cacheTtlMs = 0, now?: () => number) {
	return new AwsSecretsManagerResolver({ fetch, cacheTtlMs, now });
}

const ref = (locator: string) => ({ backend: 'aws-sm', locator });

describe('AwsSecretsManagerResolver', () => {
	it('returns a plain string secret verbatim', async () => {
		const r = resolver(async () => ({ SecretString: SECRET }));
		expect(await r.resolve(ref('prod/openai'))).toBe(SECRET);
	});

	it('selects a JSON field with #key', async () => {
		const r = resolver(async () => ({ SecretString: JSON.stringify({ OPENAI_API_KEY: SECRET }) }));
		expect(await r.resolve(ref('prod/ai#OPENAI_API_KEY'))).toBe(SECRET);
	});

	it('splits on the last # so an ARN with none is intact', async () => {
		const seen: string[] = [];
		const r = resolver(async (id) => {
			seen.push(id);
			return { SecretString: JSON.stringify({ k: 'v' }) };
		});
		await r.resolve(ref('arn:aws:secretsmanager:us-east-1:1234:secret:prod/ai-AbCdEf#k'));
		expect(seen[0]).toBe('arn:aws:secretsmanager:us-east-1:1234:secret:prod/ai-AbCdEf');
	});

	it('stringifies a non-string JSON field', async () => {
		const r = resolver(async () => ({ SecretString: JSON.stringify({ port: 5432 }) }));
		expect(await r.resolve(ref('db#port'))).toBe('5432');
	});

	it('throws an opaque error when the JSON key is missing', async () => {
		const r = resolver(async () => ({ SecretString: JSON.stringify({ other: SECRET }) }));
		await expect(r.resolve(ref('db#missing'))).rejects.toThrow(/requested JSON key/);
		await expect(r.resolve(ref('db#missing'))).rejects.not.toThrow(/db|missing/);
		await expect(r.resolve(ref('db#missing'))).rejects.not.toThrow(new RegExp(SECRET));
	});

	it('throws when the secret is not JSON but a key was requested', async () => {
		const r = resolver(async () => ({ SecretString: 'not json' }));
		await expect(r.resolve(ref('db#k'))).rejects.toThrow(/not valid JSON/);
		await expect(r.resolve(ref('db#k'))).rejects.not.toThrow(/db|#k/);
	});

	it('does not resolve an inherited prototype property as a JSON key', async () => {
		const r = resolver(async () => ({ SecretString: JSON.stringify({ real: 'v' }) }));
		await expect(r.resolve(ref('db#__proto__'))).rejects.toThrow(/requested JSON key/);
		await expect(r.resolve(ref('db#toString'))).rejects.toThrow(/requested JSON key/);
	});

	it('throws "binary" for a binary-only secret', async () => {
		const r = resolver(async () => ({ SecretBinary: new Uint8Array([1, 2, 3]) }));
		await expect(r.resolve(ref('bin'))).rejects.toThrow(/binary/);
	});

	it('maps a not-found error without leaking the value', async () => {
		const err = Object.assign(new Error('secret value here should never surface'), {
			name: 'ResourceNotFoundException',
		});
		const r = resolver(async () => {
			throw err;
		});
		await expect(r.resolve(ref('gone'))).rejects.toThrow(/ResourceNotFoundException/);
		await expect(r.resolve(ref('gone'))).rejects.not.toThrow(/gone/);
		await expect(r.resolve(ref('gone'))).rejects.not.toThrow(/should never surface/);
		await expect(r.resolve(ref('gone'))).rejects.toMatchObject({ reason: 'not_found' });
	});

	it('classifies IAM denials as forbidden — persistent, never worth a retry', async () => {
		const r = resolver(async () => {
			throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
		});
		const error = await r.resolve(ref('prod/key')).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(SecretResolutionError);
		expect(error).toMatchObject({ reason: 'forbidden' });
	});

	it('classifies transport failures as backend outages', async () => {
		const r = resolver(async () => {
			throw Object.assign(new Error('reset'), { name: 'TimeoutError' });
		});
		const error = await r.resolve(ref('prod/key')).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(SecretResolutionError);
		expect(error).toMatchObject({ reason: 'unavailable' });
	});

	it('caches within the TTL and refetches after it', async () => {
		let clock = 1000;
		const fetch = vi.fn(async () => ({ SecretString: SECRET }));
		const r = resolver(fetch, 100, () => clock);

		await r.resolve(ref('k'));
		await r.resolve(ref('k'));
		expect(fetch).toHaveBeenCalledTimes(1); // served from cache

		clock += 200; // past TTL
		await r.resolve(ref('k'));
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('shares one fetch across sibling #keys of the same secret (cache by id)', async () => {
		const fetch = vi.fn(async () => ({ SecretString: JSON.stringify({ A: '1', B: '2' }) }));
		const r = resolver(fetch, 100, () => 1000);

		expect(await r.resolve(ref('bundle#A'))).toBe('1');
		expect(await r.resolve(ref('bundle#B'))).toBe('2');
		expect(await r.resolve(ref('bundle'))).toBe(JSON.stringify({ A: '1', B: '2' }));
		expect(fetch).toHaveBeenCalledTimes(1); // one GetSecretValue for all three
	});

	it('does not cache when TTL is 0 (default)', async () => {
		const fetch = vi.fn<() => Promise<GetSecretValueResult>>(async () => ({
			SecretString: SECRET,
		}));
		const r = resolver(fetch);
		await r.resolve(ref('k'));
		await r.resolve(ref('k'));
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('does not memoize a failed fetch (a later attempt can still succeed)', async () => {
		let calls = 0;
		const fetch = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw Object.assign(new Error('flaky'), { name: 'ThrottlingException' });
			return { SecretString: SECRET };
		});
		const r = resolver(fetch, 1000, () => 1000);

		await expect(r.resolve(ref('k'))).rejects.toThrow(/ThrottlingException/);
		expect(await r.resolve(ref('k'))).toBe(SECRET);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('serves a stale value within the TTL after the underlying secret rotates', async () => {
		let current = 'v1';
		const fetch = vi.fn(async () => ({ SecretString: current }));
		const r = resolver(fetch, 100, () => 1000);

		expect(await r.resolve(ref('k'))).toBe('v1');
		current = 'v2'; // rotate underneath, still within TTL
		expect(await r.resolve(ref('k'))).toBe('v1');
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('rejects a locator with a trailing # (empty json key)', async () => {
		const r = resolver(async () => ({ SecretString: JSON.stringify({ k: 'v' }) }));
		await expect(r.resolve(ref('db#'))).rejects.toThrow(/requested JSON key/);
	});

	it('passes an empty-string locator through to the fetcher (no validation)', async () => {
		const seen: string[] = [];
		const r = resolver(async (id) => {
			seen.push(id);
			return { SecretString: SECRET };
		});
		expect(await r.resolve(ref(''))).toBe(SECRET);
		expect(seen[0]).toBe('');
	});

	it('stringifies a null JSON field value', async () => {
		const r = resolver(async () => ({ SecretString: JSON.stringify({ k: null }) }));
		expect(await r.resolve(ref('db#k'))).toBe('null');
	});
});
