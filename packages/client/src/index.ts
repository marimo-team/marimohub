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
export type IntegrationBrowseCapability = components['schemas']['IntegrationBrowseCapability'];
export type IntegrationBrowseNamespacePage =
	components['schemas']['IntegrationBrowseNamespacePage'];
export type IntegrationBrowseTablePage = components['schemas']['IntegrationBrowseTablePage'];
export type IntegrationTableSchema = components['schemas']['IntegrationTableSchema'];
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

export type ApiError = components['schemas']['ErrorResponse']['error'];
export type ServerErrorCode = ApiError['code'];
export type ApiRequestErrorCode = ServerErrorCode | 'NETWORK_ERROR' | 'PARSE_ERROR' | 'UNKNOWN';

// A `satisfies Record<ServerErrorCode, true>` map, not a cast: a server can
// emit codes this client build doesn't know (deploy skew), and the compiler
// forces this list back in sync whenever the generated union grows.
const KNOWN_SERVER_ERROR_CODES = {
	BAD_REQUEST: true,
	UNAUTHORIZED: true,
	FORBIDDEN: true,
	NOT_FOUND: true,
	CONFLICT: true,
	EDIT_SESSION_OWNED: true,
	EDIT_SESSION_CHANGED: true,
	TAKEOVER_IN_PROGRESS: true,
	GONE: true,
	PRECONDITION_FAILED: true,
	PAYLOAD_TOO_LARGE: true,
	VALIDATION_ERROR: true,
	RESOURCE_EXHAUSTED: true,
	NOT_INITIALIZED: true,
	NO_HTML_SNAPSHOT: true,
	SERVICE_UNAVAILABLE: true,
	INTERNAL_ERROR: true,
} satisfies Record<ServerErrorCode, true>;

function knownServerErrorCode(value: unknown): ApiRequestErrorCode {
	return typeof value === 'string' && Object.hasOwn(KNOWN_SERVER_ERROR_CODES, value)
		? (value as ServerErrorCode)
		: 'UNKNOWN';
}

export interface ApiResponse<T> {
	success: boolean;
	data?: T;
	error?: ApiError;
}

export class ApiRequestError extends Error {
	readonly code: ApiRequestErrorCode;
	readonly status?: number;
	readonly requestId?: string;
	readonly details?: ApiError['details'];

	constructor(
		code: ApiRequestErrorCode,
		message: string,
		options: { status?: number; requestId?: string; details?: ApiError['details'] } = {},
	) {
		super(message);
		this.name = 'ApiRequestError';
		this.code = code;
		this.status = options.status;
		this.requestId = options.requestId;
		this.details = options.details;
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

async function dispatchRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const input =
		url.origin === defaultBaseUrl ? `${url.pathname}${url.search}${url.hash}` : url.href;
	// Firefox has no Request.body getter (Bugzilla #1387483), so detect a
	// payload by reading it; '' maps to undefined so a bodyless POST does not
	// pick up a spurious text/plain content-type.
	const body =
		request.method === 'GET' || request.method === 'HEAD'
			? undefined
			: (await request.clone().text()) || undefined;
	return globalThis.fetch(input, {
		body,
		cache: request.cache,
		credentials: request.credentials,
		headers: request.headers,
		integrity: request.integrity,
		keepalive: request.keepalive,
		method: request.method,
		mode: request.mode,
		redirect: request.redirect,
		referrer: request.referrer,
		referrerPolicy: request.referrerPolicy,
		signal: request.signal,
	});
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
	return new ApiRequestError('PARSE_ERROR', `${detail}malformed response envelope`, { status });
}

function unwrapEnvelope<T>(value: T, status: number): ApiData<T> {
	if (!isRecord(value) || typeof value.success !== 'boolean') {
		throw malformedResponse(status);
	}

	if (!value.success) {
		const error = isRecord(value.error) ? value.error : undefined;
		const details = Array.isArray(error?.details)
			? error.details.filter(
					(detail): detail is { field: string; message: string } =>
						isRecord(detail) &&
						typeof detail.field === 'string' &&
						typeof detail.message === 'string',
				)
			: undefined;
		throw new ApiRequestError(
			knownServerErrorCode(error?.code),
			typeof error?.message === 'string' ? error.message : 'Request failed',
			{
				status,
				requestId: typeof error?.request_id === 'string' ? error.request_id : undefined,
				details,
			},
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

export async function apiErrorFromResponse(
	response: Response,
	fallbackMessage: string,
): Promise<ApiRequestError> {
	try {
		const body: unknown = await response.clone().json();
		try {
			unwrapEnvelope(body, response.status);
		} catch (err) {
			if (err instanceof ApiRequestError) return err;
		}
	} catch {
		// Raw-content endpoints and intermediaries may return non-JSON error bodies.
	}
	return new ApiRequestError('UNKNOWN', fallbackMessage, { status: response.status });
}
