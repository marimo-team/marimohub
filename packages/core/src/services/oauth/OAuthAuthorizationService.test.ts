import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket, ACTOR } from '../../testing';
import type { TokenService } from '../tokens/TokenService';
import type { TokenGrant } from '../../tokenGrants';
import { paths } from '../../paths';
import { OAuthAuthorizationService } from './OAuthAuthorizationService';

const GRANT: TokenGrant = { actions: ['project.read'], projects: '*' };

describe('OAuthAuthorizationService', () => {
	let bucket: MemoryBucket;
	let createToken: ReturnType<typeof vi.fn>;
	let service: OAuthAuthorizationService;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		bucket = new MemoryBucket();
		createToken = vi.fn().mockResolvedValue({ token: 'mhub_pat_test', record: { id: 'token' } });
		service = new OAuthAuthorizationService(bucket, {
			create: createToken,
		} as unknown as TokenService);
	});

	afterEach(() => vi.useRealTimers());

	async function approved(resource = 'https://hub.example/mcp') {
		const { id } = await service.begin({
			clientId: 'client',
			clientName: 'Claude',
			clientUri: 'https://claude.ai',
			redirectUri: 'cursor://oauth/callback',
			codeChallenge: 'A'.repeat(43),
			scopes: [],
			state: 'state',
			resource,
		});
		const preview = await service.preview(id);
		expect(preview).toMatchObject({
			clientName: 'Claude',
			clientUri: 'https://claude.ai',
			redirectUri: 'cursor://oauth/callback',
		});
		const redirect = await service.approve(
			id,
			{ grant: GRANT, tokenName: 'MCP · Claude', expiresInDays: 30 },
			ACTOR,
		);
		return { id, redirect, code: new URL(redirect.redirectUri).searchParams.get('code')! };
	}

	it('approves and exchanges a one-time code for a scoped token', async () => {
		const { code, redirect } = await approved();
		expect(new URL(redirect.redirectUri).searchParams.get('state')).toBe('state');
		expect(await service.challengeFor(code, 'client')).toBe('A'.repeat(43));

		await expect(
			service.exchange({
				code,
				clientId: 'client',
				redirectUri: 'cursor://oauth/callback',
				resource: 'https://hub.example/mcp',
			}),
		).resolves.toMatchObject({ token: 'mhub_pat_test' });
		expect(createToken).toHaveBeenCalledWith(
			{ name: 'MCP · Claude', expiresInDays: 30, grant: GRANT },
			ACTOR,
		);
		await expect(service.exchange({ code, clientId: 'client' })).rejects.toThrow(/invalid/);
	});

	it.each([
		{
			clientId: 'other',
			redirectUri: 'cursor://oauth/callback',
			resource: 'https://hub.example/mcp',
		},
		{ clientId: 'client', redirectUri: 'cursor://wrong', resource: 'https://hub.example/mcp' },
		{ clientId: 'client', redirectUri: 'cursor://oauth/callback', resource: 'https://other/mcp' },
	])('rejects mismatched exchange bindings', async (exchange) => {
		const { code } = await approved();
		await expect(service.exchange({ code, ...exchange })).rejects.toThrow(/invalid/);
	});

	it('denies a pending request', async () => {
		const { id } = await service.begin({
			clientId: 'client',
			redirectUri: 'https://client.example/callback',
			codeChallenge: 'A'.repeat(43),
			scopes: [],
			state: 'state',
		});
		const denied = await service.deny(id);
		expect(denied.redirectUri).toContain('error=access_denied');
		await expect(service.preview(id)).rejects.toThrow(/invalid/);
	});

	it('rejects expired pending requests', async () => {
		const { id } = await service.begin({
			clientId: 'client',
			redirectUri: 'https://client.example/callback',
			codeChallenge: 'A'.repeat(43),
			scopes: [],
		});
		vi.advanceTimersByTime(OAuthAuthorizationService.AUTHORIZATION_TTL_MS + 1);
		await expect(service.preview(id)).rejects.toThrow(/invalid/);
	});

	it('rejects an expired approved code', async () => {
		const { code } = await approved();
		vi.advanceTimersByTime(OAuthAuthorizationService.AUTHORIZATION_TTL_MS + 1);
		await expect(service.exchange({ code, clientId: 'client' })).rejects.toThrow(/invalid/);
	});

	it('prunes expired requests when authorization begins', async () => {
		await service.begin({
			clientId: 'old-client',
			redirectUri: 'https://client.example/callback',
			codeChallenge: 'A'.repeat(43),
			scopes: [],
		});
		vi.advanceTimersByTime(OAuthAuthorizationService.AUTHORIZATION_TTL_MS + 1);
		const current = await service.begin({
			clientId: 'new-client',
			redirectUri: 'https://client.example/callback',
			codeChallenge: 'B'.repeat(43),
			scopes: [],
		});
		const page = await bucket.list({ prefix: paths.oauthAuthorizationsPrefix });
		expect(page.objects.map((object) => object.key)).toEqual([
			paths.oauthAuthorization(current.id),
		]);
	});
});
