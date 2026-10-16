import { describe, expect, it } from 'vitest';
import { MAX_WORKSPACE_FILE_BYTES } from '@marimo-hub/core/constants';
import { MAX_GIT_DELTA_OPERATIONS, validateGitDelta } from './deltaLimits';

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

function delta(base: number, size: number, instructions: number[]): Uint8Array {
	return Uint8Array.from([...sizeBytes(base), ...sizeBytes(size), ...instructions]);
}

describe('Git delta limits', () => {
	it('counts bounded copy and literal operations without materializing their output', () => {
		const data = delta(10, 6, [0x91, 2, 3, 3, 97, 98, 99]);
		expect(validateGitDelta(data, 2)).toEqual({ baseSize: 10, size: 6, operations: 2 });
	});
	it('accepts an implicit 64 KiB copy length', () => {
		expect(validateGitDelta(delta(0x10000, 0x10000, [0x80]), 1)).toEqual({
			baseSize: 0x10000,
			size: 0x10000,
			operations: 1,
		});
	});
	it.each([
		['zero opcode', delta(0, 0, [0])],
		['truncated literal', delta(0, 2, [2, 97])],
		['truncated copy', delta(10, 1, [0x91, 0])],
		['out-of-bounds copy', delta(10, 2, [0x91, 9, 2])],
		['unsigned copy offset', delta(10, 1, [0x98, 0xff, 1])],
		['excess output', delta(10, 1, [0x90, 10])],
		['missing output', delta(0, 2, [1, 97])],
		['truncated size header', Uint8Array.from([0, 0x80])],
	] as const)('rejects %s', (_name, data) => {
		expect(() => validateGitDelta(data, MAX_GIT_DELTA_OPERATIONS)).toThrow('Invalid Git delta');
	});
	it.each([
		[MAX_WORKSPACE_FILE_BYTES + 1, 0],
		[0, MAX_WORKSPACE_FILE_BYTES + 1],
	])('rejects oversized base/output headers: %s/%s', (base, size) => {
		expect(() => validateGitDelta(delta(base, size, []), 1)).toThrow(
			`${MAX_WORKSPACE_FILE_BYTES}-byte limit`,
		);
	});
	it('rejects repeated copies whose real output exceeds the advertised result', () => {
		const data = delta(0x10000, 1, Array<number>(1000).fill(0x80));
		expect(() => validateGitDelta(data, MAX_GIT_DELTA_OPERATIONS)).toThrow('Invalid Git delta');
	});
	it('applies the remaining pack operation budget across deltas', () => {
		const data = delta(0, 2, [1, 97, 1, 98]);
		const first = validateGitDelta(data, 3);
		expect(() => validateGitDelta(data, 3 - first.operations)).toThrow('operation limit');
	});
	it('caps operation counts even when the claimed output and byte sizes fit', () => {
		const operations = MAX_GIT_DELTA_OPERATIONS + 1;
		const data = delta(1, operations, Array.from({ length: operations }, () => [0x90, 1]).flat());
		expect(() => validateGitDelta(data, MAX_GIT_DELTA_OPERATIONS)).toThrow('operation limit');
	});
});
