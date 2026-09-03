import { describe, expect, it, vi } from 'vitest';
import { UserId } from '@marimo-hub/core';
import type { AuthenticatedPrincipal } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing';
import { makeTestDeps } from '../testing';
import { authenticateBearer } from './auth';

const PRINCIPAL: AuthenticatedPrincipal = {
	id: UserId.parse('oauth-user'),
	email: 'oauth@example.com',
	name: 'OAuth User',
	credential: { kind: 'personal-access-token', id: 'tok-oauth' },
};

describe('authenticateBearer', () => {
	it('does not invoke the authenticator without a bearer credential', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		const authenticate = vi.fn();
		deps.authenticator = { authenticate };

		await expect(
			authenticateBearer(deps, new Request('https://hub.example/mcp')),
		).resolves.toBeNull();
		await expect(
			authenticateBearer(
				deps,
				new Request('https://hub.example/mcp', { headers: { Authorization: 'Basic abc' } }),
			),
		).resolves.toBeNull();
		expect(authenticate).not.toHaveBeenCalled();
	});

	it('rejects bearer credentials that the authenticator cannot verify', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		const authenticate = vi.fn().mockResolvedValue(null);
		deps.authenticator = { authenticate };
		const request = new Request('https://hub.example/mcp', {
			headers: { Authorization: 'Bearer invalid' },
		});

		await expect(authenticateBearer(deps, request)).resolves.toBeNull();
		expect(authenticate).toHaveBeenCalledWith(request);
	});

	it('rejects a bearer request that falls through to an SSO principal', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		deps.authenticator = {
			authenticate: vi.fn().mockResolvedValue({
				...PRINCIPAL,
				credential: { kind: 'sso' },
			}),
		};
		const suspended = vi.spyOn(deps.services.identities, 'isSuspended');

		await expect(
			authenticateBearer(
				deps,
				new Request('https://hub.example/mcp', {
					headers: { Authorization: 'Bearer opaque-sso-token' },
				}),
			),
		).resolves.toBeNull();
		expect(suspended).not.toHaveBeenCalled();
	});

	it('rejects a valid credential when its identity is suspended', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		deps.authenticator = { authenticate: vi.fn().mockResolvedValue(PRINCIPAL) };
		vi.spyOn(deps.services.identities, 'isSuspended').mockResolvedValue(true);
		const request = new Request('https://hub.example/mcp', {
			headers: { Authorization: 'Bearer suspended' },
		});

		await expect(authenticateBearer(deps, request)).resolves.toBeNull();
	});

	it('returns an active bearer principal', async () => {
		const deps = makeTestDeps(new MemoryBucket());
		deps.authenticator = { authenticate: vi.fn().mockResolvedValue(PRINCIPAL) };
		vi.spyOn(deps.services.identities, 'isSuspended').mockResolvedValue(false);

		await expect(
			authenticateBearer(
				deps,
				new Request('https://hub.example/mcp', {
					headers: { Authorization: 'Bearer valid' },
				}),
			),
		).resolves.toBe(PRINCIPAL);
	});

	it.each([
		{ resource: 'https://other.example/mcp', scopes: ['mcp:tools'] },
		{ resource: 'https://hub.example/mcp', scopes: ['other'] },
	])('rejects an OAuth credential outside the required boundary: %j', async (oauth) => {
		const deps = makeTestDeps(new MemoryBucket());
		deps.authenticator = {
			authenticate: vi
				.fn()
				.mockResolvedValue({ ...PRINCIPAL, credential: { ...PRINCIPAL.credential, oauth } }),
		};
		vi.spyOn(deps.services.identities, 'isSuspended').mockResolvedValue(false);

		await expect(
			authenticateBearer(
				deps,
				new Request('https://hub.example/mcp', {
					headers: { Authorization: 'Bearer valid' },
				}),
				{ resource: 'https://hub.example/mcp', scope: 'mcp:tools' },
			),
		).resolves.toBeNull();
	});

	it('accepts an OAuth credential with the required resource and scope', async () => {
		const oauthPrincipal: AuthenticatedPrincipal = {
			...PRINCIPAL,
			credential: {
				...PRINCIPAL.credential,
				oauth: {
					clientId: 'client-one',
					resource: 'https://hub.example/mcp',
					scopes: ['mcp:tools'],
				},
			},
		};
		const deps = makeTestDeps(new MemoryBucket());
		deps.authenticator = { authenticate: vi.fn().mockResolvedValue(oauthPrincipal) };
		vi.spyOn(deps.services.identities, 'isSuspended').mockResolvedValue(false);

		await expect(
			authenticateBearer(
				deps,
				new Request('https://hub.example/mcp', {
					headers: { Authorization: 'Bearer valid' },
				}),
				{ resource: 'https://hub.example/mcp', scope: 'mcp:tools' },
			),
		).resolves.toBe(oauthPrincipal);
	});
});
