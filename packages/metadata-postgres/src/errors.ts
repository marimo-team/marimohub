import { PreconditionFailedError } from '@marimo-hub/core/errors';

export class MetadataStorageError extends Error {
	constructor(
		readonly kind: 'unavailable' | 'corrupt' | 'serialization' | 'commit-unknown',
		readonly sqlState?: string,
	) {
		super(`Metadata storage ${kind}`);
		this.name = 'MetadataStorageError';
	}
}

export function storageError(error: unknown): Error {
	if (
		error instanceof MetadataStorageError ||
		error instanceof PreconditionFailedError ||
		error instanceof RangeError
	)
		return error;
	const code =
		error &&
		typeof error === 'object' &&
		'code' in error &&
		typeof error.code === 'string' &&
		/^[0-9A-Z]{5}$/.test(error.code)
			? error.code
			: undefined;
	return new MetadataStorageError(
		code === '40001' || code === '40P01'
			? 'serialization'
			: code?.startsWith('22') || code?.startsWith('23')
				? 'corrupt'
				: 'unavailable',
		code,
	);
}
