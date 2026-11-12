import { describe, expect, it, vi } from 'vitest';
import { GitHubAccountProvider } from './githubAccount';
const tokens = {
	access_token: 'access-secret',
	refresh_token: 'refresh-secret',
	expires_in: 3600,
	refresh_token_expires_in: 86400,
	token_type: 'bearer',
};
describe('GitHub App user authorization', () => {
	it.each([401, 403, 429, 500, 302])(
		'rejects HTTP %s without exposing provider bodies or following redirects',
		async (status) => {
			const fetcher = vi.fn<typeof fetch>(
				async () =>
					new Response('SECRET_PROVIDER_BODY', {
						status,
						headers: { location: 'https://untrusted.example/token' },
					}),
			);
			const provider = new GitHubAccountProvider('app', 'client-secret', fetcher);
			const request = provider.refresh('refresh-secret');
			await expect(request).rejects.toThrow(
				status === 401 || status === 403 ? 'reconnect' : 'unavailable',
			);
			const error: unknown = await request.catch((error: unknown) => error);
			expect(String(error)).not.toContain('SECRET');
			expect(error).not.toHaveProperty('cause');
			expect(fetcher).toHaveBeenCalledOnce();
			expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
		},
	);

	it('cancels an oversized streamed authorization response', async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(65_537));
			},
			cancel,
		});
		const provider = new GitHubAccountProvider('app', 'secret', async () => new Response(body));
		await expect(provider.identity('access-secret')).rejects.toThrow('unavailable');
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('requests S256 and expiring tokens, sends secrets only in a bounded nonredirecting body', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => Response.json(tokens));
		const provider = new GitHubAccountProvider('app', 'client-secret', fetcher, () => 1000);
		const url = new URL(
			provider.authorizationUrl({
				state: 'state',
				challenge: 'challenge',
				redirectUri: 'https://hub/callback',
			}),
		);
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			code_challenge_method: 'S256',
			scope: 'offline_access',
			state: 'state',
		});
		expect(url.href).not.toContain('secret');
		expect(
			await provider.exchange({
				code: 'code-secret',
				verifier: 'verifier-secret',
				redirectUri: 'https://hub/callback',
			}),
		).toMatchObject({ expiresAt: 3601000, refreshToken: 'refresh-secret' });
		const [endpoint, init] = fetcher.mock.calls[0];
		expect(endpoint).toBe('https://github.com/login/oauth/access_token');
		expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		expect(new URLSearchParams(String(init?.body)).get('code_verifier')).toBe('verifier-secret');
		await provider.refresh('refresh-secret');
		expect(new URLSearchParams(String(fetcher.mock.calls[1][1]?.body)).get('grant_type')).toBe(
			'refresh_token',
		);
	});
	it.each([{}, { ...tokens, refresh_token: undefined }, { ...tokens, expires_in: undefined }])(
		'rejects nonexpiring/incomplete credential pairs',
		async (body) => {
			const provider = new GitHubAccountProvider('app', 'secret', async () => Response.json(body));
			await expect(
				provider.exchange({ code: 'code', verifier: 'verifier', redirectUri: 'https://hub' }),
			).rejects.toThrow('expiring');
		},
	);
	it('does not expose provider response or transport secrets', async () => {
		for (const fetcher of [
			async () => {
				throw new Error('SECRET');
			},
			async () => new Response('SECRET'.repeat(20000)),
		]) {
			const provider = new GitHubAccountProvider('app', 'secret', fetcher);
			const error = await provider.identity('access').catch((error: unknown) => error);
			expect(String(error)).not.toContain('SECRET');
			expect(error).not.toHaveProperty('cause');
		}
	});
	it('revokes only its token rather than every authorization grant', async () => {
		const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
		await new GitHubAccountProvider('app', 'secret', fetcher).revoke('access');
		expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/applications/app/token');
		expect(fetcher.mock.calls[0][1]?.method).toBe('DELETE');
	});
});
