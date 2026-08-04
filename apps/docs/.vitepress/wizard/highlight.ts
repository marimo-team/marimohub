/**
 * Tiny dependency-free syntax highlighter for the wizard's generated output.
 * Returns HTML with token `<span>`s (rendered via v-html). Every dynamic piece
 * of text is HTML-escaped before any markup is inserted, so user-entered values
 * cannot inject markup.
 */
export type HighlightLang = 'sh' | 'yaml' | 'ts';

function esc(s: string): string {
	return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const span = (cls: string, text: string): string => `<span class="${cls}">${text}</span>`;

/** `.env`: comments, `KEY`, `=`, value, and trailing `# note`. */
function highlightEnv(line: string): string {
	if (line.startsWith('#')) return span('t-comment', esc(line));
	const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
	if (!m) return esc(line);
	const [, key, after] = m;
	let value = after;
	let comment = '';
	const ci = after.indexOf('  #');
	if (ci !== -1) {
		value = after.slice(0, ci);
		comment = after.slice(ci);
	}
	return (
		span('t-key', esc(key)) +
		span('t-op', '=') +
		(value ? span('t-val', esc(value)) : '') +
		(comment ? span('t-comment', esc(comment)) : '')
	);
}

/** YAML: comments, `indent`, `key`, `:`, value. */
function highlightYaml(line: string): string {
	if (line.trim().startsWith('#')) return span('t-comment', esc(line));
	const m = line.match(/^(\s*)([A-Za-z0-9_.-]+):(.*)$/);
	if (!m) return esc(line);
	const [, indent, key, rest] = m;
	return (
		indent + span('t-key', esc(key)) + span('t-op', ':') + (rest ? span('t-val', esc(rest)) : '')
	);
}

const TS_KEYWORDS = /\b(import|from|const|new|return|throw|async|await|function|undefined)\b/g;

/** TS: strings, `process.env.X`, keywords. Applied to already-escaped text. */
function highlightTs(line: string): string {
	let out = esc(line);
	out = out.replaceAll(/(['"])(?:(?!\1).)*\1/g, (s) => span('t-str', s));
	out = out.replaceAll(/\bprocess\.env\.[A-Z0-9_]+/g, (s) => span('t-env', s));
	out = out.replace(TS_KEYWORDS, (_, kw: string) => span('t-kw', kw));
	return out;
}

const LINE: Record<HighlightLang, (line: string) => string> = {
	sh: highlightEnv,
	yaml: highlightYaml,
	ts: highlightTs,
};

/** Highlight a multi-line block into token-span HTML (newlines preserved). */
export function highlight(code: string, lang: HighlightLang): string {
	const fn = LINE[lang];
	return code.split('\n').map(fn).join('\n');
}
