/**
 * @marimo-hub/client — the typed API client.
 *
 * `schema.ts` is generated from the API's OpenAPI 3.1 document
 * (`pnpm --filter @marimo-hub/client generate`, sourced from
 * `packages/api/openapi.yaml`, which `@marimo-hub/api`'s
 * `generateOpenApiDocument()` produces and the API's openapi.spec test keeps in
 * sync). This package replaces the hand-maintained `src/types/index.ts` the SPA
 * used to carry.
 */
import { ofetch } from 'ofetch';
export type { paths, components, operations } from './schema';
import type { components } from './schema';

/** Convenience aliases for the domain response schemas. */
export type Project = components['schemas']['Project'];
export type ProjectFederation = components['schemas']['ProjectFederation'];
export type Capabilities = components['schemas']['Capabilities'];
export type SnapshotProjectEntry = components['schemas']['SnapshotProjectEntry'];
export type SnapshotNotebookEntry = components['schemas']['SnapshotNotebookEntry'];
export type NotebookMeta = components['schemas']['NotebookMeta'];
export type NotebookDetail = components['schemas']['NotebookDetail'];
/** Result of creating a git-synced notebook: the notebook plus its sync credentials. */
export type GitNotebookCreateResult = components['schemas']['GitNotebookCreateResult'];
/** A freshly minted sync URL + write-once token (from creation or rotation). */
export type SyncToken = components['schemas']['SyncToken'];
export type Session = components['schemas']['Session'];
/** A single saved notebook revision (was `Version`). */
export type NotebookVersion = components['schemas']['NotebookVersion'];
/** Read-only deployment metadata from `GET /api/v1/version`. */
export type DeploymentInfo = components['schemas']['DeploymentInfo'];
/** A resolved user identity ({ id, email, name }) from `GET /api/v1/users`. */
export type ResolvedUser = components['schemas']['User'];

export interface ApiError {
	code: string;
	message: string;
}

export interface ApiResponse<T> {
	success: boolean;
	data?: T;
	error?: ApiError;
}

export class ApiRequestError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'ApiRequestError';
		this.code = code;
	}
}

/**
 * `ofetch` client for the SPA's `/api/*` calls. A timeout keeps a hung request
 * from stalling the UI; react-query owns query retry/backoff above this layer, so
 * we don't retry here (and so never replay a mutation). The API answers errors as
 * `{ success: false, error }` with a non-2xx status, so `ignoreResponseError` lets
 * us read that envelope ourselves instead of letting ofetch throw, and
 * `responseType: 'json'` parses the body regardless of the content-type header.
 */
const apiClient = ofetch.create({
	timeout: 20_000,
	retry: 0,
	ignoreResponseError: true,
	responseType: 'json',
});

/**
 * Fetch a `/api/*` endpoint and unwrap the `{ success, data }` envelope, throwing
 * an {@link ApiRequestError} on failure.
 */
export async function apiFetch<T>(
	input: RequestInfo | URL,
	init?: RequestInit & { timeout?: number },
): Promise<T> {
	let response;
	try {
		// ofetch's request type is `RequestInfo` (string | Request); normalize a URL.
		const request = input instanceof URL ? input.href : input;
		response = await apiClient.raw<unknown>(request, init);
	} catch (err) {
		// No HTTP response at all (network failure or timeout).
		throw new ApiRequestError(
			'NETWORK_ERROR',
			err instanceof Error ? err.message : 'Network request failed',
		);
	}

	// `_data` is the destr-parsed body. Validate it's actually our `{ success, ... }`
	// envelope before trusting it, rather than casting whatever came back.
	const parsed = response._data;
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		typeof (parsed as ApiResponse<T>).success !== 'boolean'
	) {
		throw new ApiRequestError(
			'PARSE_ERROR',
			`Server returned ${response.status} with a malformed response envelope`,
		);
	}
	const json = parsed as ApiResponse<T>;

	if (!json.success) {
		throw new ApiRequestError(
			json.error?.code ?? 'UNKNOWN',
			json.error?.message ?? 'Request failed',
		);
	}

	return json.data as T;
}
