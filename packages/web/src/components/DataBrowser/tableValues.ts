export function formatCell(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return '[unserializable]';
	}
}

export function withOccurrenceKeys<T>(
	items: readonly T[],
	fingerprint: (item: T) => string,
): { key: string; item: T }[] {
	const counts = new Map<string, number>();
	return items.map((item) => {
		const base = fingerprint(item);
		const occurrence = counts.get(base) ?? 0;
		counts.set(base, occurrence + 1);
		return { key: `${base}:${occurrence}`, item };
	});
}
