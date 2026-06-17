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
export type { paths, components, operations } from './schema';
import type { components } from './schema';

/** Convenience aliases for the domain response schemas. */
export type Project = components['schemas']['Project'];
export type SnapshotProjectEntry = components['schemas']['SnapshotProjectEntry'];
export type SnapshotNotebookEntry = components['schemas']['SnapshotNotebookEntry'];
export type NotebookMeta = components['schemas']['NotebookMeta'];
export type NotebookDetail = components['schemas']['NotebookDetail'];
export type Session = components['schemas']['Session'];
export type Version = components['schemas']['Version'];

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
 * Fetch a `/api/*` endpoint and unwrap the `{ success, data }` envelope, throwing
 * an {@link ApiRequestError} on failure.
 */
export async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
	const response = await fetch(input, init);

	let json: ApiResponse<T>;
	try {
		json = (await response.json()) as ApiResponse<T>;
	} catch {
		throw new ApiRequestError(
			'PARSE_ERROR',
			`Server returned ${response.status} with non-JSON response`,
		);
	}

	if (!json.success) {
		throw new ApiRequestError(
			json.error?.code ?? 'UNKNOWN',
			json.error?.message ?? 'Request failed',
		);
	}

	return json.data as T;
}
