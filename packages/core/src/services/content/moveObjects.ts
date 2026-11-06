import { z } from 'zod';
import type { Bucket, BucketObject } from '../../ports/bucket';
import { ConflictError, PreconditionFailedError } from '../../errors';
import { toHex } from '../../internal/hex';
import { forEachConcurrentUntilFailure } from '../../async';
import { iterateBucketPages } from '../catalog/storage';

// Each copy holds a whole object in memory, so keep a Worker's peak to a few objects.
const MOVE_COPY_CONCURRENCY = 4;

const digest = async (bytes: Uint8Array) =>
	toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));

function metadataFingerprint(object: BucketObject): string {
	return JSON.stringify([
		object.httpMetadata?.contentType ?? null,
		Object.entries(object.customMetadata ?? {}).sort(([left], [right]) =>
			left.localeCompare(right),
		),
	]);
}

export async function copyMoveObject(
	bucket: Bucket,
	source: string,
	destination: string,
	transform?: (bytes: Uint8Array) => Uint8Array,
): Promise<void> {
	const object = await bucket.get(source);
	if (!object) return;
	const original = await object.bytes();
	const bytes = transform ? transform(original) : original;
	const metadata = await bucket.head(source);
	if (!metadata || metadata.etag !== object.etag)
		throw new ConflictError('The move source changed while copying');
	try {
		await bucket.put(destination, bytes, {
			onlyIfNotExists: true,
			httpMetadata: metadata.httpMetadata,
			customMetadata: metadata.customMetadata,
		});
	} catch (error) {
		if (!(error instanceof PreconditionFailedError)) throw error;
		const existing = await bucket.get(destination);
		const existingMetadata = await bucket.head(destination);
		if (
			!existing ||
			!existingMetadata ||
			existingMetadata.etag !== existing.etag ||
			metadataFingerprint(existingMetadata) !== metadataFingerprint(metadata) ||
			(await digest(await existing.bytes())) !== (await digest(bytes))
		)
			throw new ConflictError('The move destination contains different data');
	}
}

export async function copyMovePrefix(
	bucket: Bucket,
	source: string,
	destination: string,
	options: {
		include?: (relative: string) => boolean;
		transform?: (relative: string, bytes: Uint8Array) => Uint8Array;
	} = {},
): Promise<void> {
	for await (const page of iterateBucketPages(bucket, { prefix: source, limit: 100 })) {
		// A failed move must not keep writing the destination behind a retry or cancel.
		await forEachConcurrentUntilFailure({
			items: page.objects,
			concurrency: MOVE_COPY_CONCURRENCY,
			run: async (object) => {
				const relative = object.key.slice(source.length);
				if (options.include && !options.include(relative)) return;
				await copyMoveObject(
					bucket,
					object.key,
					destination + relative,
					options.transform ? (bytes) => options.transform!(relative, bytes) : undefined,
				);
			},
		});
	}
}

export function moveJson(
	bytes: Uint8Array,
	update: (value: Record<string, unknown>) => Record<string, unknown>,
): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify(
			update(z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder().decode(bytes)))),
		),
	);
}
