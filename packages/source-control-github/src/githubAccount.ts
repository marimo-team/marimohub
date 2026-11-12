import { ForbiddenError, UnavailableError } from '@marimo-hub/core/errors';
import type {
	SourceControlAccountProvider,
	SourceControlUserTokens,
} from '@marimo-hub/core/ports/source-control-account';
import { z } from 'zod';

const tokenResponse = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	expires_in: z.number().positive().max(86400),
	refresh_token_expires_in: z.number().positive(),
	token_type: z.literal('bearer'),
});
const profileResponse = z.object({
	id: z.number().int().positive(),
	login: z.string().min(1).max(100),
});

export class GitHubAccountProvider implements SourceControlAccountProvider {
	readonly provider = 'github';
	readonly origin = 'https://github.com';
	constructor(
		readonly clientId: string,
		private readonly clientSecret: string,
		private readonly fetcher: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
	) {}

	authorizationUrl(input: { state: string; challenge: string; redirectUri: string }): string {
		const url = new URL('/login/oauth/authorize', this.origin);
		url.search = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: input.redirectUri,
			state: input.state,
			code_challenge: input.challenge,
			code_challenge_method: 'S256',
			scope: 'offline_access',
		}).toString();
		return url.href;
	}
	private async request(url: string, init: RequestInit): Promise<unknown> {
		try {
			const response = await this.fetcher(url, {
				...init,
				redirect: 'error',
				signal: AbortSignal.timeout(15_000),
			});
			if (response.status === 401 || response.status === 403)
				throw new ForbiddenError('GitHub authorization was rejected; reconnect your account');
			if (!response.ok) throw new UnavailableError('GitHub authorization is unavailable');
			if (response.status === 204) return null;
			const reader = response.body?.getReader();
			if (!reader) throw new UnavailableError('GitHub returned an invalid authorization response');
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			try {
				for (;;) {
					const result = await reader.read();
					if (result.done) break;
					bytes += result.value.length;
					if (bytes > 65536) throw new Error('response limit');
					chunks.push(result.value);
				}
			} finally {
				await reader.cancel();
			}
			return JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch (error) {
			if (error instanceof ForbiddenError) throw error;
			throw new UnavailableError(
				'GitHub authorization is unavailable; reconnect if the problem persists',
			);
		}
	}
	private async token(parameters: Record<string, string>): Promise<SourceControlUserTokens> {
		const parsed = tokenResponse.safeParse(
			await this.request('https://github.com/login/oauth/access_token', {
				method: 'POST',
				headers: {
					accept: 'application/json',
					'content-type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					...parameters,
				}),
			}),
		);
		if (!parsed.success)
			throw new ForbiddenError('GitHub did not grant expiring credentials; reconnect your account');
		return {
			accessToken: parsed.data.access_token,
			refreshToken: parsed.data.refresh_token,
			expiresAt: this.now() + parsed.data.expires_in * 1000,
			refreshExpiresAt: this.now() + parsed.data.refresh_token_expires_in * 1000,
		};
	}
	exchange(input: { code: string; verifier: string; redirectUri: string }) {
		return this.token({
			code: input.code,
			code_verifier: input.verifier,
			redirect_uri: input.redirectUri,
		});
	}
	refresh(refreshToken: string) {
		return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
	}
	async identity(accessToken: string) {
		const parsed = profileResponse.safeParse(
			await this.request('https://api.github.com/user', {
				headers: {
					accept: 'application/vnd.github+json',
					authorization: `Bearer ${accessToken}`,
					'x-github-api-version': '2022-11-28',
				},
			}),
		);
		if (!parsed.success) throw new ForbiddenError('GitHub returned an invalid account');
		return { id: String(parsed.data.id), login: parsed.data.login };
	}
	async revoke(accessToken: string): Promise<void> {
		await this.request(
			`https://api.github.com/applications/${encodeURIComponent(this.clientId)}/token`,
			{
				method: 'DELETE',
				headers: {
					accept: 'application/vnd.github+json',
					'content-type': 'application/json',
					authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
				},
				body: JSON.stringify({ access_token: accessToken }),
			},
		);
	}
}
