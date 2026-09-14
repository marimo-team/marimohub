/**
 * The bearer credential from a request's `Authorization` header, or null. The
 * scheme match is case-insensitive (`Bearer`/`bearer`/`BEARER` all parse), so
 * every consumer sees the same value — anything that re-derives "is this a PAT
 * request?" with a stricter rule would let a differently-cased scheme slip past.
 */
export function bearerToken(request: Request): string | null {
	const header = request.headers.get('authorization');
	if (!header) return null;
	const [scheme, ...rest] = header.split(' ');
	if (scheme.toLowerCase() !== 'bearer') return null;
	const token = rest.join(' ').trim();
	return token || null;
}
