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
