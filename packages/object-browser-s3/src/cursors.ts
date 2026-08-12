import { ObjectBrowseError } from '@marimo-hub/core';

export function encodeCursor(value: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify({ v: 1, ...value }), 'utf8').toString('base64url');
}

export function decodeCursor<const K extends string>(
	cursor: string | undefined,
	fields: readonly K[],
): Partial<Record<K, string>> {
	if (cursor === undefined) return {};
	try {
		if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length % 4 === 1) throw new Error('base64');
		const bytes = Buffer.from(cursor, 'base64url');
		if (bytes.toString('base64url') !== cursor) throw new Error('base64');
		const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		if (!isRecord(value) || value.v !== 1) throw new Error('version');
		const allowed = new Set<string>(['v', ...fields]);
		if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('shape');
		for (const field of fields) {
			if (value[field] !== undefined && typeof value[field] !== 'string') {
				throw new Error('shape');
			}
		}
		return Object.fromEntries(
			fields.flatMap((field) => (typeof value[field] === 'string' ? [[field, value[field]]] : [])),
		) as Partial<Record<K, string>>;
	} catch {
		throw new ObjectBrowseError('invalid_cursor', 'The object-browser cursor is invalid.');
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
