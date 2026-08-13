import { ObjectBrowseError } from '@marimo-hub/core';
import { objectBrowseHttpError } from '@marimo-hub/object-browser-commons';

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
	if (name === 'NotImplemented' || name === 'UnsupportedOperation') {
		return new ObjectBrowseError(
			'unsupported',
			'This S3-compatible provider does not support the operation.',
			requestId,
		);
	}
	const namedStatus =
		name === 'AccessDenied'
			? 403
			: name === 'NoSuchKey' || name === 'NotFound'
				? 404
				: name === 'PreconditionFailed'
					? 412
					: name === 'InvalidRange'
						? 416
						: status;
	return objectBrowseHttpError(namedStatus, {
		accessDenied: 'Access to the object store was denied.',
		unavailable: 'The object-store request failed.',
		requestId,
	});
}
