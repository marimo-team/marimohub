import { CHAT_LIMITS } from '@marimo-hub/core/chat';

// Previews are what the UI shows and what the conversation record keeps. They
// drop payload fields (code, data, query results) and anything that looks like a
// credential, so a stored transcript never becomes a secret store.
// Keys are split into words (snake, kebab, camel) and matched whole, so
// `access_token` and `apiKey` are redacted while `tokens` or `security` are not.
const PRIVATE_WORDS = new Set([
	'password',
	'passwd',
	'passphrase',
	'secret',
	'privatekey',
	'accesskey',
	'token',
	'credential',
	'credentials',
	'authorization',
	'cookie',
	'apikey',
	'sessionkey',
	'connectionstring',
	'dsn',
	'url',
	'uri',
]);
function isPrivateKey(key: string): boolean {
	const words = key
		.replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.split(/[\s_-]+/)
		.filter(Boolean);
	return words.some(
		(word, index) =>
			PRIVATE_WORDS.has(word) ||
			(index + 1 < words.length && PRIVATE_WORDS.has(word + words[index + 1])),
	);
}
const PAYLOAD_FIELD =
	/^(?:code|source|source_code|notebook_code|python_code|sql|content|stdout|stderr|query|prompt|reasoning|data|rows|records|values)$/i;
const MAX_PREVIEW = CHAT_LIMITS.previewCharacters;
const PYTHON_ERROR_TYPES = new Set([
	'AssertionError',
	'AttributeError',
	'EOFError',
	'Exception',
	'FileExistsError',
	'FileNotFoundError',
	'ImportError',
	'IndentationError',
	'IndexError',
	'KeyError',
	'ModuleNotFoundError',
	'NameError',
	'NotImplementedError',
	'OSError',
	'OverflowError',
	'PermissionError',
	'RecursionError',
	'RuntimeError',
	'StopIteration',
	'SyntaxError',
	'TabError',
	'TimeoutError',
	'TypeError',
	'UnboundLocalError',
	'UnicodeError',
	'UnicodeDecodeError',
	'UnicodeEncodeError',
	'ValueError',
	'ZeroDivisionError',
]);

/** The last Python exception class named in a failed execution's stderr. */
function pythonErrorType(value: unknown): string | undefined {
	if (
		value === null ||
		typeof value !== 'object' ||
		!('success' in value) ||
		value.success !== false ||
		!('stderr' in value) ||
		typeof value.stderr !== 'string'
	)
		return;
	let errorType: string | undefined;
	for (const match of value.stderr.slice(-64000).matchAll(/^([A-Za-z][A-Za-z0-9_]*):/gm))
		if (PYTHON_ERROR_TYPES.has(match[1])) errorType = match[1];
	return errorType;
}

const SECRET_ASSIGNMENT =
	/\b(password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization)\b\s*[=:]\s*["']?(?!\[Redacted\])[^\s"',;&]+["']?/gi;

/** Mask inline credentials in free text; links survive so the model can still use them. */
export function redactSecretText(value: string): string {
	return value
		.replaceAll(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [Redacted]')
		.replaceAll(SECRET_ASSIGNMENT, '$1=[Redacted]')
		.replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^\s"'/@]+@/gi, '$1[Redacted]@');
}

/** Previews additionally drop links: stored transcripts should not point at internal hosts. */
export function redactPreviewText(value: string): string {
	return redactSecretText(value).replaceAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, '[URL omitted]');
}

/**
 * Redact credential-like keys and inline secrets everywhere in a tool result,
 * keeping payloads such as code or output intact. Saved observations use this:
 * the model needs the data back on resume, but the record must not keep secrets.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
	if (depth > 12) return value;
	if (typeof value === 'string') return redactSecretText(value);
	if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
	if (value !== null && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [
				key,
				isPrivateKey(key) ? '[Redacted]' : redactSecrets(child, depth + 1),
			]),
		);
	return value;
}

/** Short, redacted failure line for a tool error. */
export function toolErrorSummary(value: unknown): string | undefined {
	if (typeof value === 'string') return redactPreviewText(value).slice(0, 160);
	if (
		value === null ||
		typeof value !== 'object' ||
		!('message' in value) ||
		typeof value.message !== 'string'
	)
		return;
	const code = 'code' in value && typeof value.code === 'string' ? `${value.code}: ` : '';
	return `${code}${redactPreviewText(value.message)}`.slice(0, 160);
}

export function toolPreview(value: unknown): string {
	let remaining = MAX_PREVIEW;
	const visit = (item: unknown, depth: number): unknown => {
		if (remaining <= 0 || depth > 5) return '[Omitted]';
		if (typeof item === 'string') {
			const sanitized = redactPreviewText(item);
			const limit = Math.min(400, remaining);
			remaining -= Math.min(sanitized.length, limit);
			return sanitized.length > limit ? `${sanitized.slice(0, limit)}…` : sanitized;
		}
		if (Array.isArray(item)) return item.slice(0, 8).map((child) => visit(child, depth + 1));
		if (item !== null && typeof item === 'object') {
			return Object.fromEntries(
				Object.entries(item)
					.slice(0, 20)
					.map(([key, child]) => {
						remaining -= key.length;
						const isErrorCode =
							key === 'code' && typeof child === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(child);
						if (isPrivateKey(key) || (PAYLOAD_FIELD.test(key) && !isErrorCode))
							return [key, '[Redacted or omitted]'];
						return [key, visit(child, depth + 1)];
					}),
			);
		}
		remaining -= String(item).length;
		return item;
	};
	const errorType = pythonErrorType(value);
	const previewValue =
		errorType && value !== null && typeof value === 'object'
			? { ...value, error_type: errorType }
			: value;
	const preview = JSON.stringify(visit(previewValue, 0), null, 2) ?? '';
	return preview.length > MAX_PREVIEW ? `${preview.slice(0, MAX_PREVIEW - 1)}…` : preview;
}

/**
 * Widest array or object the model receives. Paged tools are clamped to this
 * `limit`; items can still be cut by the character budget, which `boundedOutput`
 * reports on the page instead of returning a cursor that skips them.
 */
export const MODEL_OUTPUT_ITEMS = 100;
const MODEL_OUTPUT_CHARACTERS = 20000;
const SMALL_SCALAR_CHARACTERS = 256;

function isSmallScalar(key: string, value: unknown): boolean {
	if (typeof value === 'string')
		return key === 'next_cursor' || value.length <= SMALL_SCALAR_CHARACTERS;
	return value === null || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Cap what the model receives from a tool: long strings, deep nesting, and wide
 * arrays are trimmed and the trimmed paths are listed so the model knows.
 */
export function boundedOutput(data: Record<string, unknown>): Record<string, unknown> {
	let remaining = MODEL_OUTPUT_CHARACTERS;
	let budgetCuts = 0;
	const truncated: string[] = [];
	const visit = (value: unknown, path: string, depth: number): unknown => {
		if (remaining <= 0 || depth > 12) {
			if (remaining <= 0) budgetCuts += 1;
			truncated.push(path);
			return '[Content omitted]';
		}
		if (typeof value === 'string') {
			const limit = Math.min(12000, remaining);
			remaining -= Math.min(value.length, limit);
			if (value.length > limit) {
				if (limit < 12000) budgetCuts += 1;
				truncated.push(path);
				return `${value.slice(0, limit)}\n[Remaining content omitted]`;
			}
			return value;
		}
		if (Array.isArray(value)) {
			if (value.length > MODEL_OUTPUT_ITEMS) truncated.push(path);
			return value
				.slice(0, MODEL_OUTPUT_ITEMS)
				.map((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
		}
		if (value !== null && typeof value === 'object') {
			if (Object.keys(value).length > MODEL_OUTPUT_ITEMS) truncated.push(path);
			return Object.fromEntries(
				Object.entries(value)
					.slice(0, MODEL_OUTPUT_ITEMS)
					.map(([key, child]) => {
						remaining -= key.length;
						return [key, visit(child, `${path}.${key}`, depth + 1)];
					}),
			);
		}
		remaining -= String(value).length;
		return value;
	};
	// Top-level scalars such as `next_cursor` must survive intact: a cut cursor is unusable.
	const output: Record<string, unknown> = {};
	let pageCut: { key: string; index: number } | undefined;
	const entries = Object.entries(data);
	if (entries.length > MODEL_OUTPUT_ITEMS) truncated.push('$');
	for (const [key, child] of entries.slice(0, MODEL_OUTPUT_ITEMS)) {
		remaining -= key.length;
		if (isSmallScalar(key, child)) {
			output[key] = child;
			continue;
		}
		if (!Array.isArray(child)) {
			output[key] = visit(child, `$.${key}`, 1);
			continue;
		}
		if (child.length > MODEL_OUTPUT_ITEMS) truncated.push(`$.${key}`);
		const items: unknown[] = [];
		for (const [index, entry] of child.slice(0, MODEL_OUTPUT_ITEMS).entries()) {
			const cutsBefore = budgetCuts;
			items.push(visit(entry, `$.${key}[${index}]`, 2));
			if (!pageCut && budgetCuts > cutsBefore) pageCut = { key, index };
		}
		if (!pageCut && child.length > MODEL_OUTPUT_ITEMS) pageCut = { key, index: MODEL_OUTPUT_ITEMS };
		output[key] = items;
	}
	// Upstream cursors are opaque, so the hub cannot resume at the first omitted item. Returning
	// the original cursor would silently skip the cut items, so ask for a smaller page instead.
	// A partial first item is kept: no smaller page can return it whole.
	const keep = pageCut ? Math.max(pageCut.index, 1) : 0;
	if (!pageCut || !('next_cursor' in data) || keep >= (data[pageCut.key] as unknown[]).length) {
		if (truncated.length > 0) output.truncated_paths = truncated.slice(0, 30);
		return output;
	}
	const pageKey = pageCut.key;
	const prefix = `$.${pageKey}[`;
	const kept = truncated.filter(
		(path) => !path.startsWith(prefix) || Number.parseInt(path.slice(prefix.length), 10) < keep,
	);
	output[pageKey] = (output[pageKey] as unknown[]).slice(0, keep);
	delete output.next_cursor;
	output.truncated_paths = [
		`${prefix}${keep}:] omitted and next_cursor removed; repeat the call with the same cursor and limit ${keep}`,
		...kept.filter((path) => path !== `$.${pageKey}`),
	].slice(0, 30);
	return output;
}
