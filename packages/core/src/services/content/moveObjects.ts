import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import { ConflictError, PreconditionFailedError } from '../../errors';
import { toHex } from '../../internal/hex';
const digest = async (bytes: Uint8Array) =>
	toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));

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
	try {
		await bucket.put(destination, bytes, { onlyIfNotExists: true });
	} catch (error) {
		if (!(error instanceof PreconditionFailedError)) throw error;
		const existing = await bucket.get(destination);
		if (!existing || (await digest(await existing.bytes())) !== (await digest(bytes)))
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
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: source, cursor, limit: 100 });
		for (const object of page.objects) {
			const relative = object.key.slice(source.length);
			if (options.include && !options.include(relative)) continue;
			await copyMoveObject(
				bucket,
				object.key,
				destination + relative,
				options.transform ? (bytes) => options.transform!(relative, bytes) : undefined,
			);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
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
