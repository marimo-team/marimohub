import type { ObjectStoreSource } from '@marimo-hub/core';
import { describe, expect, it } from 'vitest';
import { assertBucket, assertObjectIdentity } from './validation';

const scoped: ObjectStoreSource = {
	provider: 'azure_blob',
	configured_bucket: 'safe',
	account_name: 'acct',
	endpoint_suffix: 'core.windows.net',
	auth: { method: 'account_key', account_key: 'key' },
};

const unscoped: ObjectStoreSource = { ...scoped, configured_bucket: undefined };
const s3Source: ObjectStoreSource = {
	provider: 's3',
	configured_bucket: 'safe',
	path_style: false,
	auth: { method: 'ambient' },
};

describe('assertBucket', () => {
	it('accepts the configured bucket', () => {
		expect(() => assertBucket(scoped, 'safe')).not.toThrow();
	});

	it('rejects a bucket outside the integration scope', () => {
		expect(() => assertBucket(scoped, 'secret')).toThrow(/outside this integration scope/);
	});

	it('rejects an empty bucket', () => {
		expect(() => assertBucket(unscoped, '')).toThrow(/bucket is required/);
	});

	it('allows any bucket when none is configured', () => {
		expect(() => assertBucket(unscoped, 'anything')).not.toThrow();
	});
});

describe('assertObjectIdentity', () => {
	it('accepts an ordinary key', () => {
		expect(() => assertObjectIdentity(scoped, { bucket: 'safe', key: 'a/b/c.csv' })).not.toThrow();
	});

	it('accepts a key containing dots that are not whole segments', () => {
		expect(() =>
			assertObjectIdentity(scoped, { bucket: 'safe', key: '..hidden/a..b/c.' }),
		).not.toThrow();
	});

	// A URL-addressed provider resolves these, walking out of the container.
	it.each(['../secret/creds.json', '../../other/k', 'a/../../escape.txt', 'a/./b', '..', '.'])(
		'rejects the traversing key %j',
		(key) => {
			expect(() => assertObjectIdentity(scoped, { bucket: 'safe', key })).toThrow(
				/object key is invalid/,
			);
		},
	);

	it('rejects an absolute key', () => {
		expect(() => assertObjectIdentity(scoped, { bucket: 'safe', key: '/etc/passwd' })).toThrow(
			/object key is invalid/,
		);
	});

	it('preserves opaque keys for providers that do not address objects by URL path', () => {
		for (const key of ['/leading/slash', 'a/../b', './relative']) {
			expect(() => assertObjectIdentity(s3Source, { bucket: 'safe', key })).not.toThrow();
		}
	});

	it('rejects an empty key', () => {
		expect(() => assertObjectIdentity(scoped, { bucket: 'safe', key: '' })).toThrow(
			/object key is invalid/,
		);
	});

	it('rejects a key over the byte limit', () => {
		expect(() => assertObjectIdentity(scoped, { bucket: 'safe', key: 'k'.repeat(1_025) })).toThrow(
			/object key is invalid/,
		);
	});

	it('still enforces bucket scope', () => {
		expect(() => assertObjectIdentity(scoped, { bucket: 'secret', key: 'k' })).toThrow(
			/outside this integration scope/,
		);
	});
});
