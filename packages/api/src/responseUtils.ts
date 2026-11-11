export function appendVary(headers: Headers, field: string): void {
	const vary = headers.get('Vary');
	const fields =
		vary
			?.toLowerCase()
			.split(',')
			.map((value) => value.trim()) ?? [];
	if (!fields.includes('*') && !fields.includes(field.toLowerCase())) {
		headers.set('Vary', vary ? `${vary}, ${field}` : field);
	}
}

/** Splits on commas outside quoted strings, so `foo="a, no-store"` is one directive. */
function cacheDirectiveNames(cacheControl: string): string[] {
	const names: string[] = [];
	let current = '';
	let quoted = false;
	for (let i = 0; i < cacheControl.length; i++) {
		const char = cacheControl[i];
		if (quoted && char === '\\') {
			current += char + (cacheControl[++i] ?? '');
			continue;
		}
		if (char === '"') quoted = !quoted;
		if (char === ',' && !quoted) {
			names.push(current);
			current = '';
		} else current += char;
	}
	names.push(current);
	return names.map((value) => value.split('=', 1)[0].trim().toLowerCase());
}

export function hasCacheDirective(cacheControl: string | null, directive: string): boolean {
	return cacheDirectiveNames(cacheControl ?? '').includes(directive.toLowerCase());
}
