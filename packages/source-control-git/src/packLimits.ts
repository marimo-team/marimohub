import { createInflate } from 'node:zlib';
import { BadRequestError } from '@marimo-hub/core/errors';
import { MAX_WORKSPACE_FILE_BYTES } from '@marimo-hub/core/constants';
import {
	MAX_GIT_EXPANDED_BYTES,
	MAX_GIT_EXPANDED_FILES,
} from '@marimo-hub/core/ports/source-control';
import { MAX_GIT_DELTA_OPERATIONS, validateGitDelta } from './deltaLimits';

class Cursor {
	position = 0;
	constructor(readonly bytes: Uint8Array) {}
	byte(): number {
		const value = this.bytes[this.position++];
		if (value === undefined) throw new BadRequestError('Truncated Git pack');
		return value;
	}
	size(initial = 0, initialBits = 0): number {
		let value = initial;
		let bits = initialBits;
		for (;;) {
			const byte = this.byte();
			value += (byte & 0x7f) * 2 ** bits;
			if (!Number.isSafeInteger(value) || bits > 49)
				throw new BadRequestError('Invalid Git pack object size');
			if (!(byte & 0x80)) return value;
			bits += 7;
		}
	}
}

// isomorphic-git inflates objects while indexing, before the checkout limits run.
export async function assertGitPackLimits(pack: Uint8Array, repository: string): Promise<void> {
	const invalid = () => new BadRequestError('Invalid Git pack');
	const exceeds = (limit: number) =>
		new BadRequestError(
			`The expanded Git data for ${repository} exceeds the ${limit}-byte limit; reduce the repository history or use push sync`,
		);
	if (pack.length < 32 || Buffer.from(pack.subarray(0, 4)).toString() !== 'PACK') throw invalid();
	const header = new DataView(pack.buffer, pack.byteOffset, 12);
	if (![2, 3].includes(header.getUint32(4))) throw invalid();
	const count = header.getUint32(8);
	// A shallow snapshot needs at most one object per file/directory plus its commit.
	if (count > 2 * MAX_GIT_EXPANDED_FILES + 1)
		throw new BadRequestError('Git pack contains too many objects');
	const cursor = new Cursor(pack.subarray(0, -20));
	cursor.position = 12;
	let total = 0;
	let operations = 0;
	const objectOffsets = new Set<number>();
	for (let index = 0; index < count; index++) {
		const objectOffset = cursor.position;
		const first = cursor.byte();
		const type = (first >> 4) & 7;
		if (![1, 2, 3, 4, 6, 7].includes(type)) throw invalid();
		const size = first & 0x80 ? cursor.size(first & 15, 4) : first & 15;
		if (size > MAX_WORKSPACE_FILE_BYTES) throw exceeds(MAX_WORKSPACE_FILE_BYTES);
		if (total + size > MAX_GIT_EXPANDED_BYTES) throw exceeds(MAX_GIT_EXPANDED_BYTES);
		if (type === 6) {
			let byte = cursor.byte();
			let offset = byte & 0x7f;
			while (byte & 0x80) {
				byte = cursor.byte();
				offset = (offset + 1) * 128 + (byte & 0x7f);
				if (!Number.isSafeInteger(offset) || offset > objectOffset) throw invalid();
			}
			if (!objectOffsets.has(objectOffset - offset)) throw invalid();
		} else if (type === 7) {
			for (let byte = 0; byte < 20; byte++) cursor.byte();
		}
		const inflater = createInflate();
		const delta = type === 6 || type === 7 ? new Uint8Array(size) : undefined;
		let expanded = 0;
		try {
			inflater.end(cursor.bytes.subarray(cursor.position));
			for await (const chunk of inflater) {
				if (expanded + chunk.length > size) throw invalid();
				delta?.set(chunk, expanded);
				expanded += chunk.length;
			}
		} catch (error) {
			if (error instanceof BadRequestError) throw error;
			throw invalid();
		} finally {
			inflater.destroy();
		}
		if (expanded !== size || inflater.bytesWritten === 0) throw invalid();
		cursor.position += inflater.bytesWritten;
		let resolvedSize = size;
		if (delta) {
			const validated = validateGitDelta(delta, MAX_GIT_DELTA_OPERATIONS - operations);
			resolvedSize = validated.size;
			operations += validated.operations;
		}
		// Delta instructions and reconstructed objects both consume memory during indexing.
		total += Math.max(size, resolvedSize);
		if (total > MAX_GIT_EXPANDED_BYTES) throw exceeds(MAX_GIT_EXPANDED_BYTES);
		objectOffsets.add(objectOffset);
	}
	if (cursor.position !== cursor.bytes.length) throw invalid();
}
