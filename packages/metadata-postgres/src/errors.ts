import { DomainError, UnavailableError } from '@marimo-hub/core/errors';

export class MetadataUnavailableError extends UnavailableError {
	readonly kind = 'unavailable';
	constructor(readonly sqlState?: string) {
		super('Metadata storage unavailable');
		this.name = 'MetadataUnavailableError';
	}
}

export class MetadataStorageError extends Error {
	constructor(
		readonly kind: 'corrupt' | 'serialization' | 'commit-unknown',
		readonly sqlState?: string,
	) {
		super(`Metadata storage ${kind}`);
		this.name = 'MetadataStorageError';
	}
}

export function storageError(error: unknown): Error {
	if (
		error instanceof MetadataStorageError ||
		error instanceof DomainError ||
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
	if (code === '40001' || code === '40P01') return new MetadataStorageError('serialization', code);
	if (code?.startsWith('22') || code?.startsWith('23'))
		return new MetadataStorageError('corrupt', code);
	return new MetadataUnavailableError(code);
}
