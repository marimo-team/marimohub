import type { ObjectIdentity, ObjectStoreSource } from '@marimo-hub/core/ports/object-browser';
import { ObjectBrowseError } from '@marimo-hub/core/ports/object-browser';

export function assertBucket(source: ObjectStoreSource, bucket: string): void {
	if (!bucket) throw new ObjectBrowseError('not_found', 'A bucket is required.');
	if (source.configured_bucket && source.configured_bucket !== bucket) {
		throw new ObjectBrowseError('access_denied', 'The bucket is outside this integration scope.');
	}
}

export function assertObjectIdentity(source: ObjectStoreSource, request: ObjectIdentity): void {
	assertBucket(source, request.bucket);
	if (!request.key || new TextEncoder().encode(request.key).length > 1_024) {
		throw new ObjectBrowseError('not_found', 'The object key is invalid.');
	}
	if (hasUnsafeObjectPath(source.provider, request.key)) {
		throw new ObjectBrowseError('not_found', 'The object key is invalid.');
	}
}

function hasUnsafeObjectPath(provider: ObjectStoreSource['provider'], key: string): boolean {
	// Azure preserves slashes; GCS encodes them, so only a whole-key dot segment escapes.
	if (provider === 'azure_blob') return key.startsWith('/') || key.split('/').some(isDotSegment);
	return provider === 'gcs' && isDotSegment(key);
}

function isDotSegment(segment: string): boolean {
	return segment === '.' || segment === '..';
}
