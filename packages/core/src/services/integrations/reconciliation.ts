function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}

export function changedConfigPaths(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): string[] {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])]
		.sort()
		.filter((key) => canonical(before[key]) !== canonical(after[key]))
		.map((key) => `config.${key}`);
}
