import { readResponseBytes } from '@marimo-hub/source-control-git/http';
import { deadlineSignal, withAbortSignal } from '@marimo-hub/core/async';
import { DefaultAzureCredential } from '@azure/identity';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	UnavailableError,
} from '@marimo-hub/core/errors';
import { markSourceControlPublishFailure } from '@marimo-hub/core/ports/source-control';
import type { AzureRepository } from './repository';
import { validateOrganization } from './repository';

export interface AzureCredential {
	getToken(
		scope: string,
		options?: { abortSignal?: AbortSignal },
	): Promise<{ token: string } | null>;
}
export interface AzureDevOpsOptions {
	organization: string;
	credential?: AzureCredential;
}
export interface AzureDevOpsRuntime {
	fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}
export const AZURE_DEVOPS_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default';

export function boundedBytes(
	response: Response,
	limit: number,
	signal?: AbortSignal | null,
): Promise<Uint8Array> {
	return readResponseBytes(response, limit, 'Azure DevOps', signal);
}

export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new UnavailableError('Invalid Azure DevOps response');
	return value as Record<string, unknown>;
}
export function stringField(value: unknown, key: string): string {
	const result = record(value)[key];
	if (typeof result !== 'string' || !result)
		throw new UnavailableError(`Invalid Azure DevOps ${key}`);
	return result;
}
export function values(value: unknown): unknown[] {
	const result = record(value).value;
	if (!Array.isArray(result)) throw new UnavailableError('Invalid Azure DevOps response list');
	return result;
}

function requestError(status: number): Error & { providerStatus: number } {
	let error: Error;
	switch (status) {
		case 404:
			error = new NotFoundError('Azure DevOps repository, branch, or object was not found');
			break;
		case 401:
		case 403:
			error = new ForbiddenError('Azure DevOps access was denied');
			break;
		case 409:
		case 412:
			error = new ConflictError('Azure DevOps branch changed while publishing');
			break;
		default:
			error = new UnavailableError(`Azure DevOps request failed with status ${status}`);
	}
	return Object.assign(error, { providerStatus: status });
}

export class AzureClient {
	readonly organization: string;
	readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>;
	private readonly credential: AzureCredential;
	constructor(options: AzureDevOpsOptions, runtime: AzureDevOpsRuntime = {}) {
		this.organization = validateOrganization(options.organization);
		this.credential = options.credential ?? new DefaultAzureCredential();
		this.fetcher = runtime.fetcher ?? fetch;
	}
	async authorization(signal = deadlineSignal(60_000)): Promise<string> {
		try {
			signal.throwIfAborted();
			const result = await withAbortSignal(
				this.credential.getToken(AZURE_DEVOPS_SCOPE, { abortSignal: signal }),
				signal,
			);
			if (!result?.token) throw new Error('Missing access token');
			return `Bearer ${result.token}`;
		} catch {
			throw markSourceControlPublishFailure(
				new UnavailableError('Azure DevOps authentication failed'),
				{ provider: 'azure-devops', stage: 'auth' },
			);
		}
	}
	async request(
		repo: AzureRepository,
		path: string,
		query: Record<string, string> = {},
		init: RequestInit = {},
	): Promise<Response> {
		init.signal?.throwIfAborted();
		const url = `${repo.apiUrl}${path}?${new URLSearchParams({ ...query, 'api-version': '7.1' })}`;
		const headers = new Headers(init.headers);
		const signal = deadlineSignal(60_000, init.signal ?? undefined);
		try {
			headers.set('authorization', await this.authorization(signal));
		} catch (error) {
			init.signal?.throwIfAborted();
			throw error;
		}
		init.signal?.throwIfAborted();
		headers.set('accept', headers.get('accept') ?? 'application/json');
		if (init.body) headers.set('content-type', 'application/json');
		let response: Response;
		try {
			signal.throwIfAborted();
			response = await withAbortSignal(
				this.fetcher(url, {
					...init,
					headers,
					redirect: 'error',
					signal,
				}),
				signal,
			);
		} catch {
			init.signal?.throwIfAborted();
			throw new UnavailableError('Azure DevOps is unavailable');
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw requestError(response.status);
		}
		return response;
	}
	async json(
		repo: AzureRepository,
		path: string,
		query: Record<string, string> = {},
		init: RequestInit = {},
	): Promise<unknown> {
		const response = await this.request(repo, path, query, init);
		if (response.headers.has('x-ms-continuationtoken')) {
			await response.body?.cancel().catch(() => {});
			throw new BadRequestError('Azure DevOps result exceeds the supported page size');
		}
		const bytes = await boundedBytes(response, 8 * 1024 * 1024, init.signal);
		try {
			return JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			throw new UnavailableError('Invalid Azure DevOps JSON response');
		}
	}
}
