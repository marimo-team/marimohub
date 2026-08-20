import { createPrivateKey, createSign } from 'node:crypto';
import { markSourceControlPublishFailure, UnavailableError } from '@marimo-hub/core';
import { numberField, responseJson, stringField } from './githubResponses';

export type GitHubFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubAppPublisherOptions {
	/** Numeric id shown on the GitHub App settings page. */
	appId: string;
	/** PKCS1/PKCS8 PEM, or a base64 encoding of the PEM. */
	privateKey: string;
}

export interface GitHubAppPublisherRuntime {
	/** Optional fetch implementation for the host runtime. */
	fetcher?: GitHubFetch;
	/** Optional clock, primarily for deterministic tests. */
	now?: () => number;
}

const GITHUB_API_BASE_URL = 'https://api.github.com';
class GitHubRequestError extends UnavailableError {
	readonly providerStatus: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'GitHubRequestError';
		this.providerStatus = status;
	}
}

function githubRequestError(response: Response): GitHubRequestError {
	return new GitHubRequestError(
		response.status,
		`GitHub request failed with status ${response.status}`,
	);
}

function encodeBase64Url(value: string): string {
	return Buffer.from(value).toString('base64url');
}

function privateKeyPem(value: string): string {
	const trimmed = value.trim();
	return trimmed.includes('BEGIN') ? trimmed : Buffer.from(trimmed, 'base64').toString('utf8');
}

export class GitHubClient {
	private readonly appId: string;
	private readonly fetcher: GitHubFetch;
	private readonly now: () => number;
	private readonly key: ReturnType<typeof createPrivateKey>;

	constructor(options: GitHubAppPublisherOptions, runtime: GitHubAppPublisherRuntime = {}) {
		if (!/^[1-9]\d*$/.test(options.appId.trim())) {
			throw new Error('GitHub App id must be a positive integer');
		}
		if (!options.privateKey.trim()) throw new Error('GitHub App private key is required');
		this.appId = options.appId.trim();
		this.fetcher = runtime.fetcher ?? fetch;
		this.now = runtime.now ?? Date.now;
		this.key = createPrivateKey(privateKeyPem(options.privateKey));
		if (this.key.asymmetricKeyType !== 'rsa') {
			throw new Error('GitHub App private key must be RSA');
		}
	}

	private appJwt(): string {
		const nowSeconds = Math.floor(this.now() / 1000);
		if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
			throw new UnavailableError('GitHub App clock is invalid');
		}
		const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
		const payload = encodeBase64Url(
			JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: this.appId }),
		);
		const unsigned = `${header}.${payload}`;
		const signature = createSign('RSA-SHA256').update(unsigned).end().sign(this.key, 'base64url');
		return `${unsigned}.${signature}`;
	}

	async request(
		path: string,
		token: string,
		init: RequestInit = {},
		allowedStatuses: readonly number[] = [],
	): Promise<Response> {
		let response: Response;
		try {
			const headers = new Headers(init.headers);
			headers.set('accept', 'application/vnd.github+json');
			headers.set('authorization', `Bearer ${token}`);
			headers.set('content-type', 'application/json');
			headers.set('x-github-api-version', '2022-11-28');
			response = await this.fetcher(`${GITHUB_API_BASE_URL}${path}`, {
				...init,
				headers,
			});
		} catch (error) {
			throw new UnavailableError('GitHub is unavailable', { cause: error });
		}
		if (!response.ok && !allowedStatuses.includes(response.status)) {
			throw githubRequestError(response);
		}
		return response;
	}

	async installationToken(owner: string, repo: string): Promise<string> {
		let jwt: string;
		try {
			jwt = this.appJwt();
		} catch (error) {
			throw markSourceControlPublishFailure(error, { provider: 'github', stage: 'auth' });
		}
		let installationResponse: Response;
		try {
			installationResponse = await this.request(
				`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
				jwt,
				{},
				[404],
			);
		} catch (error) {
			throw markSourceControlPublishFailure(error, {
				provider: 'github',
				stage: 'installation',
				status: error instanceof GitHubRequestError ? error.providerStatus : undefined,
			});
		}
		if (installationResponse.status === 404) {
			throw markSourceControlPublishFailure(
				new UnavailableError(`The GitHub App is not installed for ${owner}/${repo}`),
				{ provider: 'github', stage: 'installation', status: 404 },
			);
		}
		const installationId = numberField(await responseJson(installationResponse), 'id');
		let tokenResponse: Response;
		try {
			tokenResponse = await this.request(
				`/app/installations/${installationId}/access_tokens`,
				jwt,
				{
					method: 'POST',
					body: JSON.stringify({
						repositories: [repo],
						permissions: { contents: 'write', pull_requests: 'write' },
					}),
				},
			);
		} catch (error) {
			throw markSourceControlPublishFailure(error, {
				provider: 'github',
				stage: 'auth',
				status: error instanceof GitHubRequestError ? error.providerStatus : undefined,
			});
		}
		return stringField(await responseJson(tokenResponse), 'token');
	}
}
