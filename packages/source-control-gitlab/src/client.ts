import {
	providerHttpError,
	readResponseBytes,
	responseFields,
} from '@marimo-hub/source-control-git/http';
import { deadlineSignal, withDeadline } from '@marimo-hub/core/async';
import { BadRequestError, UnavailableError } from '@marimo-hub/core/errors';
import { hasControlCharacter } from '@marimo-hub/source-control-git/validation';
import { gitLabOrigin } from './repository';
import type { GitLabRepository } from './repository';

export interface GitLabOptions {
	token: string;
	url?: string;
}
export interface GitLabRuntime {
	fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}

export const { record, stringField } = responseFields('GitLab');

export class GitLabClient {
	readonly origin: string;
	readonly fetcher: NonNullable<GitLabRuntime['fetcher']>;
	constructor(
		private readonly options: GitLabOptions,
		runtime: GitLabRuntime = {},
	) {
		this.origin = gitLabOrigin(options.url);
		if (!options.token.trim() || /\s/.test(options.token) || hasControlCharacter(options.token))
			throw new BadRequestError('Invalid GitLab access token');
		this.fetcher = runtime.fetcher ?? fetch;
	}
	gitAuthorization(): string {
		return `Basic ${Buffer.from(`oauth2:${this.options.token}`).toString('base64')}`;
	}
	async fetch(url: string, init: RequestInit): Promise<Response> {
		init.signal?.throwIfAborted();
		let response: Response;
		try {
			response = await withDeadline(
				(signal) => this.fetcher(url, { ...init, signal, redirect: 'error' }),
				{
					timeoutMs: 60_000,
					signal: init.signal ?? undefined,
					timeoutError: () => new UnavailableError('GitLab is unavailable'),
					unref: true,
				},
			);
		} catch {
			init.signal?.throwIfAborted();
			throw new UnavailableError('GitLab is unavailable');
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw providerHttpError('GitLab', response.status, { headers: response.headers });
		}
		return response;
	}
	async data(
		repo: GitLabRepository,
		path: string,
		query: Record<string, string> = {},
		init: RequestInit = {},
		limit = 4 * 1024 * 1024,
	) {
		const signal = deadlineSignal(60_000, init.signal ?? undefined);
		const headers = new Headers(init.headers);
		headers.set('PRIVATE-TOKEN', this.options.token);
		if (init.body) headers.set('content-type', 'application/json');
		const response = await this.fetch(`${repo.apiUrl}${path}?${new URLSearchParams(query)}`, {
			...init,
			headers,
			signal,
		});
		try {
			return {
				bytes: await readResponseBytes(response, limit, 'GitLab', signal),
				headers: response.headers,
			};
		} catch (error) {
			init.signal?.throwIfAborted();
			if (error instanceof BadRequestError || error instanceof UnavailableError) throw error;
			throw new UnavailableError('GitLab response could not be read', { cause: error });
		}
	}
	async json(
		repo: GitLabRepository,
		path: string,
		query: Record<string, string> = {},
		init: RequestInit = {},
	) {
		const { bytes, headers } = await this.data(repo, path, query, init);
		try {
			return { value: JSON.parse(new TextDecoder().decode(bytes)), headers };
		} catch {
			throw new UnavailableError('Invalid GitLab JSON response');
		}
	}
}
