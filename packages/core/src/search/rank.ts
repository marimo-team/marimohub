import type { SearchDocument } from './contracts';
import { terms, termMatches } from './contracts';

export function snippet(text: string, query: string) {
	const wanted = new Set(terms(query));
	const tokens = [...termMatches(text)];
	const matches = tokens.filter((m) => wanted.has(m[0].normalize('NFC').toLowerCase()));
	let start = Math.max(0, (matches[0]?.index ?? 0) - 100);
	const leading = tokens.find((m) => m.index < start && m.index + m[0].length > start);
	if (leading) start = leading.index + leading[0].length;
	// Offsets remain UTF-16 for browser highlights, without cutting a surrogate pair.
	if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start] ?? '')) start++;
	let end = Math.min(text.length, start + 400);
	const trailing = tokens.find((m) => m.index < end && m.index + m[0].length > end);
	if (trailing && trailing.index > start) end = trailing.index;
	if (/[\uDC00-\uDFFF]/u.test(text[end] ?? '')) end--;
	const value = text.slice(start, end);
	return {
		text: value,
		highlights: matches
			.filter((m) => m.index >= start && m.index + m[0].length <= start + value.length)
			.slice(0, 200)
			.map((m) => ({ start: m.index - start, end: m.index - start + m[0].length })),
	};
}
export function rank(
	documents: SearchDocument[],
	query: string,
	embedding?: { space: string; vector: number[] },
) {
	const wanted = terms(query);
	const rows = documents.map((document) => {
		const title = new Set(terms(document.title));
		const content = new Set(terms(document.text));
		const lexical = wanted.reduce(
			(n, t) => n + (title.has(t) ? 3 : 0) + (content.has(t) ? 1 : 0),
			0,
		);
		const vector = document.embedding;
		let semantic = 0;
		if (
			embedding &&
			vector?.space === embedding.space &&
			vector.vector.length === embedding.vector.length
		) {
			const norm = Math.hypot(...vector.vector) * Math.hypot(...embedding.vector);
			semantic = norm
				? vector.vector.reduce((n, x, i) => n + x * embedding.vector[i], 0) / norm
				: 0;
		}
		return { document, lexical, semantic, score: 0 };
	});
	for (const field of ['lexical', 'semantic'] as const)
		rows
			.filter((r) => r[field] > 0)
			.sort((a, b) => b[field] - a[field] || a.document.id.localeCompare(b.document.id))
			.forEach((r, i) => {
				r.score += 1 / (60 + i + 1);
			});
	return rows
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id));
}
export function resourceHref(projectId: string, document: SearchDocument): string {
	const base = `/projects/${encodeURIComponent(projectId)}`;
	const ref = document.resource;
	if (ref.type === 'notebook') return `${base}/notebooks/${encodeURIComponent(ref.notebook_id)}`;
	if (ref.type === 'chat') return `${base}/chat/${encodeURIComponent(ref.conversation_id)}`;
	if (document.kind === 'datasource') return `${base}/integrations`;
	const params = new URLSearchParams();
	if (ref.namespace) params.set('ns', ref.namespace.join('\u001f'));
	if (ref.table) params.set('table', ref.table);
	return `${base}/data/${encodeURIComponent(ref.integration_id)}${params.size > 0 ? `?${params}` : ''}`;
}
