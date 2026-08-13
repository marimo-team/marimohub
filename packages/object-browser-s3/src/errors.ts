import { ObjectBrowseError } from '@marimo-hub/core';
import { isAbortError, objectBrowseHttpError } from '@marimo-hub/object-browser-commons';

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
	if (isAbortError(error)) return new ObjectBrowseError('aborted', 'The request was canceled.');
	let mappedStatus: number | undefined;
	if (status === 401 || status === 403 || name === 'AccessDenied') {
		mappedStatus = status === 401 ? 401 : 403;
	} else if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') {
		mappedStatus = 404;
	} else if (status === 412 || name === 'PreconditionFailed') {
		mappedStatus = 412;
	} else if (status === 416 || name === 'InvalidRange') {
		mappedStatus = 416;
	} else if (name === 'NotImplemented' || name === 'UnsupportedOperation') {
		return new ObjectBrowseError(
			'unsupported',
			'This S3-compatible provider does not support the operation.',
			requestId,
		);
	} else {
		mappedStatus = status;
	}
	return objectBrowseHttpError(mappedStatus, {
		accessDenied: 'Access to the object store was denied.',
		unavailable: 'The object-store request failed.',
		requestId,
	});
}
