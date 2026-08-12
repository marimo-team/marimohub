import { ObjectBrowseError } from '@marimo-hub/core';

export function encodeCursor(value: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify({ v: 1, ...value }), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, unknown>>(
	cursor: string | undefined,
): Partial<T> {
	if (!cursor) return {};
	try {
		const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T & {
			v?: unknown;
		};
		if (value.v !== 1) throw new Error('version');
		return value;
	} catch {
		throw new ObjectBrowseError('invalid_cursor', 'The object-browser cursor is invalid.');
	}
}
