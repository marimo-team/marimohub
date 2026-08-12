import { ObjectBrowseError } from '@marimo-hub/core';

export function mapS3Error(error: unknown): ObjectBrowseError {
	if (error instanceof ObjectBrowseError) return error;
	const value = error as {
		name?: string;
		Code?: string;
		$metadata?: { httpStatusCode?: number; requestId?: string };
	};
	const name = value?.name ?? value?.Code ?? '';
	const status = value?.$metadata?.httpStatusCode;
	const requestId = value?.$metadata?.requestId;
	if (name === 'AbortError') return new ObjectBrowseError('aborted', 'The request was canceled.');
	if (status === 403 || name === 'AccessDenied') {
		return new ObjectBrowseError(
			'access_denied',
			'Access to the object store was denied.',
			requestId,
		);
	}
	if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') {
		return new ObjectBrowseError('not_found', 'The requested object was not found.', requestId);
	}
	if (status === 412 || name === 'PreconditionFailed') {
		return new ObjectBrowseError(
			'precondition_failed',
			'The object changed before it could be read.',
			requestId,
		);
	}
	if (status === 416 || name === 'InvalidRange') {
		return new ObjectBrowseError(
			'range_not_satisfiable',
			'The requested byte range is not available.',
			requestId,
		);
	}
	if (name === 'NotImplemented' || name === 'UnsupportedOperation') {
		return new ObjectBrowseError(
			'unsupported',
			'This S3-compatible provider does not support the operation.',
			requestId,
		);
	}
	return new ObjectBrowseError('unavailable', 'The object-store request failed.', requestId);
}
