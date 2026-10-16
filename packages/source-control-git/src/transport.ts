import git from 'isomorphic-git';
import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git';
import { withAbortSignal } from '@marimo-hub/core/async';
import {
	BadRequestError,
	DomainError,
	ForbiddenError,
	NotFoundError,
	UnavailableError,
} from '@marimo-hub/core/errors';
import { MAX_GIT_FETCH_BYTES } from '@marimo-hub/core/ports/source-control';

export type GitFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitTransportTimeouts {
	headersMs: number;
	idleMs: number;
}

// A single total budget would have to fit a 25 MiB pack on the slowest supported link, so it
// would either cut off slow-but-progressing transfers or leave stalled ones hanging for minutes.
// Bounding time-to-headers and the gap between body chunks fails stalls fast without capping
// total transfer time; the byte cap bounds the total instead.
export const DEFAULT_GIT_TRANSPORT_TIMEOUTS: GitTransportTimeouts = {
	headersMs: 60_000,
	idleMs: 60_000,
};

// The headers timer also covers uploading the buffered push pack (up to 25 MiB).
export const PUSH_GIT_TRANSPORT_TIMEOUTS: GitTransportTimeouts = {
	headersMs: 300_000,
	idleMs: 60_000,
};

function repositorySizeError(repository: string, limit: number): BadRequestError {
	return new BadRequestError(
		`The Git data for ${repository} exceeds the ${limit}-byte pull-source limit; reduce the repository history or use push sync`,
	);
}

export class GitFetchByteLimit {
	private received = 0;

	constructor(private readonly repository: string) {}

	assertFits(size: number): void {
		if (!Number.isSafeInteger(size) || size < 0 || this.received + size > MAX_GIT_FETCH_BYTES) {
			throw repositorySizeError(this.repository, MAX_GIT_FETCH_BYTES);
		}
	}

	record(size: number): void {
		this.assertFits(size);
		this.received += size;
	}
}

async function requestBody(
	body: GitHttpRequest['body'],
): Promise<Uint8Array<ArrayBuffer> | undefined> {
	if (!body) return undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body) {
		chunks.push(chunk);
		size += chunk.byteLength;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function startTimer(
	transfer: AbortController,
	timeoutMs: number,
	message: string,
): ReturnType<typeof setTimeout> {
	const timer = setTimeout(() => transfer.abort(new UnavailableError(message)), timeoutMs);
	(timer as { unref?: () => void }).unref?.();
	return timer;
}

function responseBody(
	response: Response,
	recordBytes: (size: number) => void,
	transfer: AbortController,
	signal: AbortSignal,
	idleMs: number,
	onError: (error: unknown) => void,
): AsyncIterableIterator<Uint8Array> {
	const body = response.body;
	return (async function* () {
		if (!body) return;
		const reader = body.getReader();
		try {
			for (;;) {
				const timer = startTimer(transfer, idleMs, 'Git server stopped sending data');
				let next: ReadableStreamReadResult<Uint8Array>;
				try {
					next = await withAbortSignal(reader.read(), signal);
				} finally {
					clearTimeout(timer);
				}
				if (next.done) break;
				recordBytes(next.value.byteLength);
				yield next.value;
			}
		} catch (error) {
			onError(error);
			throw error;
		} finally {
			await reader.cancel().catch(() => {});
		}
	})();
}

export interface GitHttpOptions {
	fetcher: GitFetch;
	repository: string;
	remoteUrl: string;
	signal?: AbortSignal;
	timeouts?: GitTransportTimeouts;
}

function assertGitEndpoint(url: string, remote: URL): void {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		throw new BadRequestError('Invalid Git endpoint');
	}
	const prefix = `${remote.pathname.replace(/\/+$/, '')}/`;
	if (
		target.origin !== remote.origin ||
		!target.pathname.startsWith(prefix) ||
		target.username ||
		target.password
	)
		throw new BadRequestError('Invalid Git endpoint');
}

export interface GitHttpClient extends HttpClient {
	/**
	 * isomorphic-git replaces some transport errors with its own (a stalled ref advertisement
	 * surfaces as a SmartHttpError), so callers report this first transport failure instead.
	 */
	failure(): DomainError | undefined;
}

/**
 * Credentials ride on every request, so each one is pinned to the remote repository and
 * redirects are refused rather than followed to a host that would receive the token.
 */
export function gitHttp(options: GitHttpOptions): GitHttpClient {
	const limit = new GitFetchByteLimit(options.repository);
	const remote = new URL(options.remoteUrl);
	const timeouts = options.timeouts ?? DEFAULT_GIT_TRANSPORT_TIMEOUTS;
	let failure: DomainError | undefined;
	const remember = (error: unknown) => {
		if (error instanceof DomainError) failure ??= error;
	};
	return {
		failure: () => failure,
		request: (request) =>
			send(request).catch((error: unknown) => {
				remember(error);
				throw error;
			}),
	};

	async function send(request: GitHttpRequest): Promise<GitHttpResponse> {
		assertGitEndpoint(request.url, remote);
		options.signal?.throwIfAborted();
		const body = await requestBody(request.body);
		const transfer = new AbortController();
		const signal = options.signal
			? AbortSignal.any([options.signal, transfer.signal])
			: transfer.signal;
		const timer = startTimer(transfer, timeouts.headersMs, 'Git server did not respond in time');
		let response: Response;
		try {
			response = await withAbortSignal(
				options.fetcher(request.url, {
					method: request.method,
					headers: request.headers,
					body: body?.buffer,
					redirect: 'error',
					signal,
				}),
				signal,
			);
		} finally {
			clearTimeout(timer);
		}
		if (response.redirected || (response.status >= 300 && response.status < 400)) {
			await response.body?.cancel().catch(() => {});
			throw Object.assign(new UnavailableError('Git server redirected the request'), {
				providerStatus: response.status,
			});
		}
		const contentLength = Number(response.headers.get('content-length'));
		if (Number.isFinite(contentLength) && contentLength >= 0) {
			try {
				limit.assertFits(contentLength);
			} catch (error) {
				await response.body?.cancel().catch(() => {});
				throw error;
			}
		}
		return {
			url: response.url || request.url,
			method: request.method,
			statusCode: response.status,
			statusMessage: response.statusText,
			headers: Object.fromEntries(response.headers.entries()),
			body: responseBody(
				response,
				(size) => limit.record(size),
				transfer,
				signal,
				timeouts.idleMs,
				remember,
			),
		};
	}
}

function httpStatus(error: unknown): number | undefined {
	if (error instanceof git.Errors.HttpError) return error.data.statusCode;
	const status = (error as { providerStatus?: unknown } | null)?.providerStatus;
	return typeof status === 'number' ? status : undefined;
}

export function gitTransportError(
	error: unknown,
	message: string,
	transport?: GitHttpClient,
): Error {
	if (error instanceof DomainError) return error;
	const failure = transport?.failure();
	if (failure) return failure;
	if (error instanceof git.Errors.UnsafeFilepathError)
		return new BadRequestError('Git tree contains an unsafe path');
	const status = httpStatus(error);
	const mapped =
		status === 401 || status === 403
			? new ForbiddenError('Git server denied access to the repository')
			: status === 404
				? new NotFoundError('Git repository was not found')
				: new UnavailableError(message, { cause: error });
	return status === undefined ? mapped : Object.assign(mapped, { providerStatus: status });
}
