import { MAX_WORKSPACE_FILE_BYTES } from '@marimo-hub/core/constants';
import { BadRequestError } from '@marimo-hub/core/errors';

export const MAX_GIT_DELTA_OPERATIONS = 100_000;

export function validateGitDelta(
	data: Uint8Array,
	remainingOperations: number,
): { baseSize: number; size: number; operations: number } {
	const invalid = () => new BadRequestError('Invalid Git delta');
	let position = 0;
	function byte(): number {
		const value = data[position++];
		if (value === undefined) throw invalid();
		return value;
	}
	function sizeHeader(): number {
		let size = 0;
		let bits = 0;
		for (;;) {
			const value = byte();
			size += (value & 0x7f) * 2 ** bits;
			if (!Number.isSafeInteger(size) || bits > 49) throw invalid();
			if (size > MAX_WORKSPACE_FILE_BYTES)
				throw new BadRequestError(`Git delta exceeds the ${MAX_WORKSPACE_FILE_BYTES}-byte limit`);
			if (!(value & 0x80)) return size;
			bits += 7;
		}
	}
	function copyField(flags: number, bytes: number): number {
		let value = 0;
		for (let index = 0; index < bytes; index++) {
			if (flags & (1 << index)) value += byte() * 2 ** (8 * index);
		}
		return value;
	}
	const baseSize = sizeHeader();
	const size = sizeHeader();
	const operationLimit = Math.min(remainingOperations, MAX_GIT_DELTA_OPERATIONS);
	let operations = 0;
	let output = 0;
	while (position < data.length) {
		if (++operations > operationLimit)
			throw new BadRequestError('Git delta exceeds the operation limit');
		const opcode = byte();
		let length: number;
		if (opcode & 0x80) {
			const offset = copyField(opcode & 0x0f, 4);
			length = copyField((opcode >> 4) & 0x07, 3) || 0x10000;
			if (offset + length > baseSize) throw invalid();
		} else {
			length = opcode;
			if (length === 0 || position + length > data.length) throw invalid();
			position += length;
		}
		output += length;
		if (output > size) throw invalid();
	}
	if (output !== size) throw invalid();
	return { baseSize, size, operations };
}
