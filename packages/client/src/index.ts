/**
 * Typed requests backed by the generated OpenAPI schema.
 * Regenerate it with `pnpm --filter @marimo-hub/client generate`.
 */
import createClient from 'openapi-fetch';
import type { ClientOptions, Middleware } from 'openapi-fetch';
export type { paths, components, operations } from './schema';
import type { components, paths } from './schema';

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
/** An integration kind's catalog card and config form schema. */
export type IntegrationKind = components['schemas']['IntegrationKind'];
/** A project integration list item without config. */
export type IntegrationEntry = components['schemas']['IntegrationEntry'];
/** An integration with its current, redacted config. */
export type IntegrationDetail = components['schemas']['IntegrationDetail'];
/** Metadata for one immutable config revision. */
export type IntegrationVersion = components['schemas']['IntegrationVersion'];
/** Result of an integration connectivity probe. */
export type IntegrationTestResult = components['schemas']['IntegrationTestResult'];
/** A single saved notebook revision (was `Version`). */
export type NotebookVersion = components['schemas']['NotebookVersion'];
/** Read-only deployment metadata from `GET /api/v1/version`. */
export type DeploymentInfo = components['schemas']['DeploymentInfo'];
export type User = components['schemas']['Me'];
/** A resolved user identity ({ id, email, name }) from `GET /api/v1/users`. */
export type ResolvedUser = components['schemas']['User'];
/** A personal access token's metadata (never the secret). */
export type ApiToken = components['schemas']['ApiToken'];
/** The create response: metadata plus the one-time plaintext `token`. */
export type ApiTokenCreated = components['schemas']['ApiTokenCreated'];
export type AuditLogEntry = components['schemas']['AuditLogEntry'];
export type AuditLogPage = components['schemas']['AuditLogPage'];
/** A directory entry from the super-admin `GET /api/v1/admin/users`. */
export type AdminUser = components['schemas']['AdminUser'];
/** Redacted deployment configuration from the super-admin `GET /api/v1/admin/config`. */
export type DeploymentConfig = components['schemas']['DeploymentConfig'];

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

const DEFAULT_TIMEOUT_MS = 20_000;

type RequestWithTimeout = Request & { timeout?: unknown };

const timeoutMiddleware: Middleware = {
	onRequest({ request }) {
		const requestedTimeout = (request as RequestWithTimeout).timeout;
		const timeout =
			typeof requestedTimeout === 'number' &&
			Number.isFinite(requestedTimeout) &&
			requestedTimeout > 0
				? requestedTimeout
				: DEFAULT_TIMEOUT_MS;
		return new Request(request, {
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]),
		});
	},
};

const defaultBaseUrl =
	typeof globalThis.location === 'object' ? globalThis.location.origin : 'http://localhost';

function dispatchRequest(request: Request): Promise<Response> {
	// Forward the Request itself rather than reconstructing RequestInit. The
	// reconstruction dropped JSON bodies in Firefox after request middleware ran.
	// Native fetch preserves the request's internal body stream across browsers.
	return globalThis.fetch(request);
}

export function createApiClient(options: ClientOptions = {}) {
	const { baseUrl = defaultBaseUrl, fetch = dispatchRequest, ...rest } = options;
	const client = createClient<paths>({ ...rest, baseUrl, fetch });
	client.use(timeoutMiddleware);
	return client;
}

export const apiClient = createApiClient();

type FetchResult<T> =
	| { data: T; error?: never; response: Response }
	| { data?: never; error: unknown; response: Response };

export type ApiData<T> = T extends { success: true; data: infer Data }
	? Data
	: T extends { success: true }
		? void
		: never;

export interface ApiDataWithResponse<T> {
	data: ApiData<T>;
	response: Response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformedResponse(status?: number): ApiRequestError {
	const detail = status === undefined ? '' : `Server returned ${status} with a `;
	return new ApiRequestError('PARSE_ERROR', `${detail}malformed response envelope`);
}

function unwrapEnvelope<T>(value: T, status: number): ApiData<T> {
	if (!isRecord(value) || typeof value.success !== 'boolean') {
		throw malformedResponse(status);
	}

	if (!value.success) {
		const error = isRecord(value.error) ? value.error : undefined;
		throw new ApiRequestError(
			typeof error?.code === 'string' ? error.code : 'UNKNOWN',
			typeof error?.message === 'string' ? error.message : 'Request failed',
		);
	}

	return value.data as ApiData<T>;
}

export async function apiDataWithResponse<T>(
	request: Promise<FetchResult<T>>,
): Promise<ApiDataWithResponse<T>> {
	let result: FetchResult<T>;
	try {
		result = await request;
	} catch (err) {
		if (err instanceof SyntaxError) {
			throw malformedResponse();
		}
		throw new ApiRequestError(
			'NETWORK_ERROR',
			err instanceof Error ? err.message : 'Network request failed',
		);
	}

	if (result.error !== undefined) {
		return {
			data: unwrapEnvelope(result.error, result.response.status),
			response: result.response,
		};
	}

	return {
		data: unwrapEnvelope(result.data, result.response.status),
		response: result.response,
	};
}

/** Unwrap the API envelope and normalize API, transport, and parse failures. */
export async function apiData<T>(request: Promise<FetchResult<T>>): Promise<ApiData<T>> {
	return (await apiDataWithResponse(request)).data;
}
