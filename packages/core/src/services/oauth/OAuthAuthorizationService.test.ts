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
		{ clientId: 'client', resource: 'https://hub.example/mcp' },
		{ clientId: 'client', redirectUri: 'cursor://wrong', resource: 'https://hub.example/mcp' },
		{ clientId: 'client', redirectUri: 'cursor://oauth/callback', resource: 'https://other/mcp' },
		{ clientId: 'client', redirectUri: 'cursor://oauth/callback' },
	])('rejects mismatched exchange bindings', async (exchange) => {
		const { code } = await approved();
		await expect(service.exchange({ code, ...exchange })).rejects.toThrow(/invalid/);
	});

	it('rejects malformed, unknown, and tampered codes without creating a token', async () => {
		const { code } = await approved();
		const tampered = `${code.slice(0, -1)}${code.endsWith('0') ? '1' : '0'}`;
		const unknown = `mhub_oac_01ARZ3NDEKTSV4RRFFQ69G5FAV_${'0'.repeat(32)}`;

		for (const candidate of ['not-an-authorization-code', unknown, tampered]) {
			await expect(service.challengeFor(candidate, 'client')).rejects.toThrow(/invalid/);
		}
		expect(createToken).not.toHaveBeenCalled();
	});

	it('allows only one concurrent approval', async () => {
		const { id } = await service.begin({
			clientId: 'client',
			redirectUri: 'cursor://oauth/callback',
			codeChallenge: 'A'.repeat(43),
			scopes: [],
		});
		const input = { grant: GRANT, tokenName: 'MCP', expiresInDays: 30 };
		const attempts = await Promise.allSettled([
			service.approve(id, input, ACTOR),
			service.approve(id, input, ACTOR),
		]);

		expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
	});

	it('allows only one concurrent exchange', async () => {
		const { code } = await approved();
		const input = {
			code,
			clientId: 'client',
			redirectUri: 'cursor://oauth/callback',
			resource: 'https://hub.example/mcp',
		};
		const attempts = await Promise.allSettled([service.exchange(input), service.exchange(input)]);

		expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
		expect(createToken).toHaveBeenCalledOnce();
	});

	it('consumes the code when token creation fails', async () => {
		createToken.mockRejectedValueOnce(new Error('token store unavailable'));
		const { code } = await approved();

		await expect(
			service.exchange({
				code,
				clientId: 'client',
				redirectUri: 'cursor://oauth/callback',
				resource: 'https://hub.example/mcp',
			}),
		).rejects.toThrow('token store unavailable');
		await expect(service.challengeFor(code, 'client')).rejects.toThrow(/invalid/);
	});

	it('preserves callback parameters when it adds an authorization result', async () => {
		const { id } = await service.begin({
			clientId: 'client',
			redirectUri: 'https://client.example/callback?source=desktop',
			codeChallenge: 'A'.repeat(43),
			scopes: [],
			state: 'request-state',
		});
		const approvedResult = await service.approve(
			id,
			{ grant: GRANT, tokenName: 'MCP', expiresInDays: 30 },
			ACTOR,
		);
		const redirect = new URL(approvedResult.redirectUri);

		expect(redirect.searchParams.get('source')).toBe('desktop');
		expect(redirect.searchParams.get('state')).toBe('request-state');
		expect(redirect.searchParams.get('code')).toMatch(/^mhub_oac_/);
	});

	it.each(['approve', 'deny'] as const)('preserves empty state when users %s', async (decision) => {
		const { id } = await service.begin({
			clientId: 'client',
			redirectUri: 'https://client.example/callback',
			codeChallenge: 'A'.repeat(43),
			scopes: [],
			state: '',
		});
		const result =
			decision === 'approve'
				? await service.approve(id, { grant: GRANT, tokenName: 'MCP', expiresInDays: 30 }, ACTOR)
				: await service.deny(id);
		const redirect = new URL(result.redirectUri);

		expect(redirect.searchParams.has('state')).toBe(true);
		expect(redirect.searchParams.get('state')).toBe('');
	});

	it('treats malformed stored records as invalid', async () => {
		const { id } = await service.begin({
			clientId: 'client',
			redirectUri: 'https://client.example/callback',
			codeChallenge: 'A'.repeat(43),
			scopes: [],
		});
		await bucket.put(paths.oauthAuthorization(id), JSON.stringify({ id, status: 'pending' }));

		await expect(service.preview(id)).rejects.toThrow(/invalid/);
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
