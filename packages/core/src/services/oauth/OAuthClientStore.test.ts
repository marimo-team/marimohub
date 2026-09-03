import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../../testing';
import { paths } from '../../paths';
import { OAuthClientStore } from './OAuthClientStore';

describe('OAuthClientStore', () => {
	let bucket: MemoryBucket;
	let store: OAuthClientStore;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		bucket = new MemoryBucket();
		store = new OAuthClientStore(bucket);
	});

	afterEach(() => vi.useRealTimers());

	it('registers public clients and expires them', async () => {
		const client = await store.register({
			client_name: 'Claude',
			redirect_uris: ['https://client.example/callback'],
		});

		expect(client).toMatchObject({
			client_name: 'Claude',
			token_endpoint_auth_method: 'none',
		});
		expect(await store.get(client.client_id)).toEqual(client);

		vi.advanceTimersByTime(OAuthClientStore.CLIENT_TTL_MS + 1);
		expect(await store.get(client.client_id)).toBeNull();
	});

	it('prunes expired registrations when a client registers', async () => {
		await store.register({ redirect_uris: ['https://old.example/callback'] });
		vi.advanceTimersByTime(OAuthClientStore.CLIENT_TTL_MS + 1);
		const current = await store.register({ redirect_uris: ['https://new.example/callback'] });
		const page = await bucket.list({ prefix: paths.oauthClientsPrefix });
		expect(page.objects.map((object) => object.key)).toEqual([
			paths.oauthClient(current.client_id),
		]);
	});

	it.each([
		'http://example.com/callback',
		'ftp://example.com/callback',
		'file:///tmp/callback',
		'javascript:alert(1)',
		'not a URL',
	])('rejects unsafe redirect URI %s', async (redirectUri) => {
		await expect(store.register({ redirect_uris: [redirectUri] })).rejects.toThrow(
			/OAuth redirect_uris/,
		);
	});

	it.each([
		'https://example.com/callback',
		'http://localhost:1234/callback',
		'http://127.0.0.1:1234/callback',
		'http://[::1]:1234/callback',
		'cursor://oauth/callback',
		'com.example.app:/oauth/callback',
	])('accepts redirect URI %s', async (redirectUri) => {
		await expect(store.register({ redirect_uris: [redirectUri] })).resolves.toBeDefined();
	});
});
