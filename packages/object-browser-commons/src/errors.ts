import { ObjectBrowseError } from '@marimo-hub/core';

/**
 * Operation deadlines are composed from `AbortSignal.timeout`, whose reason is
 * a DOMException named `TimeoutError`, so cancellation checks must accept both.
 */
export function isAbortError(error: unknown): boolean {
	const name = (error as { name?: unknown } | null)?.name;
	return name === 'AbortError' || name === 'TimeoutError';
}

export function objectBrowseHttpError(
	status: number | undefined,
	options: { accessDenied: string; unavailable: string; requestId?: string },
): ObjectBrowseError {
	const common = { requestId: options.requestId };
	switch (status) {
		case undefined:
			return error('unavailable', options.unavailable, common);
		case 401:
		case 403:
			return error('access_denied', options.accessDenied, common);
		case 404:
			return error('not_found', 'The requested object was not found.', common);
		case 412:
			return error('precondition_failed', 'The object changed before it could be read.', common);
		case 416:
			return error('range_not_satisfiable', 'The requested byte range is not available.', common);
		default:
			return error('unavailable', options.unavailable, common);
	}
}

function error(
	code: ConstructorParameters<typeof ObjectBrowseError>[0],
	message: string,
	options: { requestId?: string },
): ObjectBrowseError {
	return new ObjectBrowseError(code, message, options.requestId);
}
