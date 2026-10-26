import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAX_WORKSPACE_FILE_BYTES } from '@marimo-hub/core/constants';
import {
	MAX_GIT_EXPANDED_BYTES,
	MAX_GIT_EXPANDED_FILES,
} from '@marimo-hub/core/ports/source-control';
import { assertGitPackLimits } from './packLimits';
import { MAX_GIT_DELTA_OPERATIONS } from './deltaLimits';

function sizeBytes(input: number): number[] {
	let value = input;
	const bytes: number[] = [];
	do {
		const byte = value % 128;
		value = Math.floor(value / 128);
		bytes.push(byte | (value ? 0x80 : 0));
	} while (value);
	return bytes;
}

function object(type: number, data: Uint8Array, declaredSize = data.length, offset = 9): Buffer {
	const remaining = Math.floor(declaredSize / 16);
	const header = [(type << 4) | (declaredSize % 16) | (remaining ? 0x80 : 0)];
	if (remaining) header.push(...sizeBytes(remaining));
	const base = type === 6 ? Buffer.from([offset]) : type === 7 ? Buffer.alloc(20) : Buffer.alloc(0);
	return Buffer.concat([Buffer.from(header), base, deflateSync(data)]);
}

function pack(...objects: Buffer[]): Buffer {
	const header = Buffer.alloc(12);
	header.write('PACK');
	header.writeUInt32BE(2, 4);
	header.writeUInt32BE(objects.length, 8);
	return Buffer.concat([header, ...objects, Buffer.alloc(20)]);
}

describe('Git pack expansion limits', () => {
	it('checks advertised object sizes before attempting decompression', async () => {
		const data = pack(object(3, new Uint8Array(), MAX_WORKSPACE_FILE_BYTES + 1));
		await expect(assertGitPackLimits(data, 'owner/repo')).rejects.toThrow(
			`${MAX_WORKSPACE_FILE_BYTES}-byte limit`,
		);
	});
	it('caps streaming expansion when a compressed object lies about its size', async () => {
		const data = pack(object(3, new Uint8Array(1024 * 1024), 1));
		await expect(assertGitPackLimits(data, 'owner/repo')).rejects.toThrow('Invalid Git pack');
	});
	it.each([6, 7])('rejects oversized reconstructed objects for delta type %s', async (type) => {
		const delta = Uint8Array.from([0, ...sizeBytes(MAX_WORKSPACE_FILE_BYTES + 1)]);
		await expect(
			assertGitPackLimits(pack(object(3, new Uint8Array()), object(type, delta)), 'owner/repo'),
		).rejects.toThrow(`${MAX_WORKSPACE_FILE_BYTES}-byte limit`);
	});
	it('counts reconstructed delta sizes toward the aggregate limit', async () => {
		const delta = Uint8Array.from([
			...sizeBytes(MAX_WORKSPACE_FILE_BYTES),
			...sizeBytes(MAX_WORKSPACE_FILE_BYTES),
			...Array<number>(MAX_WORKSPACE_FILE_BYTES / 65536).fill(0x80),
		]);
		const data = pack(...Array.from({ length: 5 }, () => object(7, delta)));
		await expect(assertGitPackLimits(data, 'owner/repo')).rejects.toThrow(
			`${MAX_GIT_EXPANDED_BYTES}-byte limit`,
		);
	});
	it.each([6, 7])(
		'accepts bounded delta headers of type %s and following objects',
		async (type) => {
			const delta = Uint8Array.from([0, 1, 1, 97]);
			const data = pack(object(3, new Uint8Array()), object(type, delta), object(3, delta));
			await expect(assertGitPackLimits(data, 'owner/repo')).resolves.toBeUndefined();
		},
	);
	it('rejects truncated delta size headers', async () => {
		await expect(
			assertGitPackLimits(pack(object(7, Uint8Array.from([0, 0x80]))), 'owner/repo'),
		).rejects.toThrow('Invalid Git delta');
	});
	it.each([0, 1])(
		'shares the delta operation budget across the pack (extra: %s)',
		async (extra) => {
			const operations = MAX_GIT_DELTA_OPERATIONS / 2 + extra;
			const delta = Uint8Array.from([
				0,
				...sizeBytes(operations),
				...Array.from({ length: operations }, () => [1, 97]).flat(),
			]);
			const result = assertGitPackLimits(pack(object(7, delta), object(7, delta)), 'owner/repo');
			if (extra) {
				await expect(result).rejects.toThrow(
					`Git delta exceeds the operation limit of ${MAX_GIT_DELTA_OPERATIONS} per pack`,
				);
			} else {
				await expect(result).resolves.toBeUndefined();
			}
		},
	);
	it('rejects unsafe object size integers', async () => {
		const data = pack(Buffer.from([0xb0, ...Array<number>(8).fill(0xff), 0x01]));
		await expect(assertGitPackLimits(data, 'owner/repo')).rejects.toThrow(
			'Invalid Git pack object size',
		);
	});
	it('rejects truncated compressed streams', async () => {
		const entry = object(3, Uint8Array.from([97]));
		await expect(assertGitPackLimits(pack(entry.subarray(0, -2)), 'owner/repo')).rejects.toThrow();
	});
	it.each([0, 1, 10])(
		'rejects OFS deltas that do not reference an earlier object boundary: %s',
		async (offset) => {
			const delta = Uint8Array.from([0, 1, 1, 97]);
			const data = pack(object(3, new Uint8Array()), object(6, delta, delta.length, offset));
			await expect(assertGitPackLimits(data, 'owner/repo')).rejects.toThrow('Invalid Git pack');
		},
	);
	it('bounds indexing metadata even when all objects are empty', async () => {
		const data = pack();
		data.writeUInt32BE(2 * MAX_GIT_EXPANDED_FILES + 2, 8);
		await expect(assertGitPackLimits(data, 'owner/repo')).rejects.toThrow('too many objects');
	});
	it('rejects trailing objects not included in the pack count', async () => {
		const data = pack(object(3, Uint8Array.from([97])));
		data.writeUInt32BE(0, 8);
		await expect(assertGitPackLimits(data, 'owner/repo')).rejects.toThrow('Invalid Git pack');
	});
});
