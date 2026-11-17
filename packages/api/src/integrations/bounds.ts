import { ValidationError } from '@marimo-hub/core';

export const DATA_MAX_BYTES = 16_384;
export const dataBytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function boundedData<T>(value: T): T {
	if (dataBytes(value) > DATA_MAX_BYTES)
		throw new ValidationError(
			'Result exceeds the data output limit. Request fewer items or a narrower namespace.',
		);
	return value;
}
