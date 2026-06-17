/** Case-insensitive substring match; the query is trimmed before comparing. */
export function matchesQuery(text: string, query: string): boolean {
	return text.toLowerCase().includes(query.trim().toLowerCase());
}

/**
 * Filter a list by a free-text query against a caller-supplied text projection.
 * An empty/whitespace query returns the original list unchanged (same reference).
 * Pure and generic so every search box in the app shares one implementation.
 *
 * @example filterBySearch(projects, q, (p) => `${p.name} ${p.description}`)
 */
export function filterBySearch<T>(
	items: readonly T[],
	query: string,
	getText: (item: T) => string,
): T[] {
	const q = query.trim();
	if (!q) return items as T[];
	return items.filter((item) => matchesQuery(getText(item), q));
}
