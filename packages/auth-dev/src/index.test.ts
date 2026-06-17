import { describe, it, expect } from 'vitest';
import { DevAuthenticator } from './index';

describe('DevAuthenticator', () => {
	it('returns the configured fixed user for every request', async () => {
		const auth = new DevAuthenticator({ userId: 'u', email: 'e@x' });
		expect(await auth.authenticate()).toEqual({ id: 'u', email: 'e@x' });
	});

	it('falls back to the default user when no config is given', async () => {
		const auth = new DevAuthenticator();
		expect(await auth.authenticate()).toEqual({ id: 'user', email: 'user@localhost' });
	});

	it('has no logout URL', () => {
		expect(new DevAuthenticator().logoutUrl()).toBeNull();
	});
});
