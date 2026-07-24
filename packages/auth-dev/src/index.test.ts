import { describe, it, expect } from 'vitest';
import { DevAuthenticator } from './index';

describe('DevAuthenticator', () => {
	it('returns the configured fixed user for every request', async () => {
		const auth = new DevAuthenticator({ userId: 'u', email: 'e@x', name: 'Dev U' });
		expect(await auth.authenticate()).toEqual({ id: 'u', email: 'e@x', name: 'Dev U' });
	});

	it('falls back to the default user (incl. a display name) when no config is given', async () => {
		const auth = new DevAuthenticator();
		expect(await auth.authenticate()).toEqual({
			id: 'user',
			email: 'user@localhost',
			name: 'Local Dev',
		});
	});

	it('has no logout URL', () => {
		expect(new DevAuthenticator().logoutUrl()).toBeNull();
	});

	// The dev bypass has no production refusal: under NODE_ENV=production it still
	// authenticates every request as a fixed user, and config/src/auth.ts accepts
	// MARIMOHUB_AUTH_BACKEND=dev unconditionally. This pins the current (unsafe)
	// behavior; flip it to `.toThrow()` once a production gate exists.
	it('is NOT blocked in a production configuration (invariant currently unenforced)', async () => {
		const prev = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production';
		try {
			const auth = new DevAuthenticator();
			await expect(auth.authenticate()).resolves.toEqual({
				id: 'user',
				email: 'user@localhost',
				name: 'Local Dev',
			});
		} finally {
			process.env.NODE_ENV = prev;
		}
	});
});
