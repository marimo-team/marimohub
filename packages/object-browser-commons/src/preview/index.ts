import type {
	ObjectBrowseContext,
	ObjectIdentity,
	ObjectPreview,
	ObjectPreviewRequest,
	TabularPreview,
} from '@marimo-hub/core';
import { ObjectBrowseError } from '@marimo-hub/core';
import { parse } from 'csv-parse/sync';
import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import type { AsyncBuffer } from 'hyparquet';
import { decodeAscii, detectRasterImage } from '../formats';
import type { ObjectBrowserLimits } from '../limits';
import { arrayBuffer } from '../streams';

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_COLUMNS = 200;
const MAX_CELL_BYTES = 8 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_PARQUET_REQUESTS = 64;

export interface ObjectPreviewHead {
	total_bytes: number;
	content_type?: string;
	etag?: string;
}

export interface ObjectPreviewReader {
	head(request: ObjectIdentity, signal: AbortSignal): Promise<ObjectPreviewHead>;
	readRange(
		request: ObjectIdentity,
		start: number,
		end: number,
		options: { etag?: string; signal: AbortSignal },
	): Promise<Uint8Array>;
}

export async function previewObject(
	reader: ObjectPreviewReader,
	limits: ObjectBrowserLimits,
	context: ObjectBrowseContext,
	request: ObjectPreviewRequest,
): Promise<ObjectPreview> {
	const deadline = AbortSignal.timeout(limits.previewTimeoutMs);
	const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
	const head = await reader.head(request, signal);
	const totalBytes = head.total_bytes;
	const probeLength = Math.min(totalBytes, limits.previewMaxBytes);
	const bytes =
		probeLength === 0
			? new Uint8Array()
			: await reader.readRange(request, 0, probeLength, {
					etag: head.etag,
					signal,
				});
	const detected = detectFormat(
		bytes,
		request.key,
		head.content_type,
		bytes.byteLength < totalBytes,
	);
	if (detected.kind === 'image') {
		if (totalBytes > limits.inlineImageMaxBytes) {
			return unsupported(
				'The image exceeds the inline preview limit.',
				detected.format,
				totalBytes,
			);
		}
		return {
			kind: 'image',
			format: detected.format,
			content_url: request.content_url,
			total_bytes: totalBytes,
			warnings: [],
		};
	}
	if (detected.kind === 'parquet') {
		return previewParquet(reader, limits, request, head, signal);
	}
	if (detected.kind === 'csv') {
		return previewDelimited(bytes, totalBytes, request.limit, detected.delimiter, detected.format);
	}
	if (detected.kind === 'jsonl') {
		return previewJsonLines(bytes, totalBytes, request.limit);
	}
	if (detected.kind === 'json') return previewJson(bytes, totalBytes, request.limit);
	if (detected.kind === 'text') {
		return previewText(bytes, totalBytes, detected.format);
	}
	return unsupported('This object format cannot be previewed safely.', detected.type, totalBytes);
}

type Detected =
	| { kind: 'image'; format: 'png' | 'jpeg' | 'gif' | 'webp' }
	| { kind: 'parquet' }
	| { kind: 'csv'; format: 'csv' | 'tsv'; delimiter: ',' | '\t' | ';' }
	| { kind: 'json' }
	| { kind: 'jsonl' }
	| { kind: 'text'; format: 'text' | 'markdown' | 'code' | 'log' }
	| { kind: 'unsupported'; type?: string };

function detectFormat(
	bytes: Uint8Array,
	key: string,
	contentType: string | undefined,
	truncated: boolean,
): Detected {
	const image = detectRasterImage(bytes);
	if (image) return { kind: 'image', format: image };
	if (decodeAscii(bytes.slice(0, 4)) === 'PAR1') return { kind: 'parquet' };
	const extension = key.split('.').at(-1)?.toLowerCase();
	const safeType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
	if (safeType && ACTIVE_CONTENT_TYPES.has(safeType)) {
		return { kind: 'unsupported', type: safeType };
	}
	if (safeType === 'application/x-ndjson' || extension === 'jsonl' || extension === 'ndjson') {
		return { kind: 'jsonl' };
	}
	if (safeType === 'application/json' || extension === 'json') return { kind: 'json' };
	if (safeType === 'text/csv' || extension === 'csv') {
		return { kind: 'csv', format: 'csv', delimiter: detectDelimiter(bytes, truncated) };
	}
	if (safeType === 'text/tab-separated-values' || extension === 'tsv') {
		return { kind: 'csv', format: 'tsv', delimiter: '\t' };
	}
	if (extension === 'parquet') return { kind: 'parquet' };
	if (extension === 'md' || extension === 'markdown') return { kind: 'text', format: 'markdown' };
	if (extension === 'log') return { kind: 'text', format: 'log' };
	if (CODE_EXTENSIONS.has(extension ?? '')) return { kind: 'text', format: 'code' };
	if (safeType?.startsWith('text/') || TEXT_EXTENSIONS.has(extension ?? '')) {
		return { kind: 'text', format: 'text' };
	}
	return { kind: 'unsupported', type: safeType ?? extension };
}

function previewDelimited(
	bytes: Uint8Array,
	totalBytes: number,
	limit: number,
	delimiter: ',' | '\t' | ';',
	format: 'csv' | 'tsv',
): TabularPreview {
	const warnings: string[] = [];
	const truncated = bytes.byteLength < totalBytes;
	let records: unknown[][];
	try {
		const decoded = decodeUtf8(bytes, truncated);
		records = parse(truncated ? completeLinePrefix(decoded) : decoded, {
			bom: true,
			delimiter,
			skip_empty_lines: true,
			relax_column_count: true,
			relax_quotes: true,
			skip_records_with_error: truncated,
			to: limit + 2,
		}) as unknown[][];
	} catch {
		throw new ObjectBrowseError('unsupported', 'The delimited file is malformed.');
	}
	const rawHeader = records.shift() ?? [];
	const visibleRows = records.slice(0, limit);
	const header = normalizeHeaders(rawHeader.slice(0, MAX_COLUMNS));
	const rows = visibleRows.map((row) => normalizeRow(row.slice(0, MAX_COLUMNS), warnings));
	return boundTable({
		kind: 'tabular',
		format,
		columns: header.map((name) => ({ name })),
		rows,
		truncated:
			truncated ||
			records.length > limit ||
			rawHeader.length > MAX_COLUMNS ||
			visibleRows.some((row) => row.length > MAX_COLUMNS),
		bytes_read: bytes.byteLength,
		total_bytes: totalBytes,
		warnings,
	});
}

function completeLinePrefix(value: string): string {
	if (value.endsWith('\n')) return value;
	const lastNewline = value.lastIndexOf('\n');
	return lastNewline === -1 ? '' : value.slice(0, lastNewline + 1);
}

function previewJsonLines(bytes: Uint8Array, totalBytes: number, limit: number): TabularPreview {
	const truncated = bytes.byteLength < totalBytes;
	const text = decodeUtf8(bytes, truncated);
	const lines = text.split(/\r?\n/);
	if (truncated) lines.pop();
	const values: unknown[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			values.push(JSON.parse(line));
		} catch {
			throw new ObjectBrowseError('unsupported', 'The JSON Lines file is malformed.');
		}
		if (values.length > limit) break;
	}
	return valuesToTable(values, 'jsonl', bytes.byteLength, totalBytes, truncated, limit);
}

function previewJson(bytes: Uint8Array, totalBytes: number, limit: number): ObjectPreview {
	const truncated = bytes.byteLength < totalBytes;
	let value: unknown;
	try {
		value = JSON.parse(decodeUtf8(bytes, truncated));
	} catch {
		if (truncated) {
			return unsupported('The JSON value exceeds the preview byte limit.', 'json', totalBytes);
		}
		throw new ObjectBrowseError('unsupported', 'The JSON file is malformed.');
	}
	if (Array.isArray(value)) {
		return valuesToTable(value, 'json', bytes.byteLength, totalBytes, truncated, limit);
	}
	if (isRecord(value)) {
		const warnings: string[] = [];
		return boundTable({
			kind: 'tabular',
			format: 'json',
			columns: [{ name: 'key' }, { name: 'value' }],
			rows: Object.entries(value)
				.slice(0, limit)
				.map(([key, child]) => [key, normalizeValue(child, warnings)]),
			truncated: truncated || Object.keys(value).length > limit,
			bytes_read: bytes.byteLength,
			total_bytes: totalBytes,
			warnings,
		});
	}
	const text = JSON.stringify(normalizeValue(value, []), null, 2);
	return {
		kind: 'text',
		format: 'json',
		text,
		truncated,
		bytes_read: bytes.byteLength,
		total_bytes: totalBytes,
		warnings: [],
	};
}

function valuesToTable(
	values: unknown[],
	format: 'json' | 'jsonl',
	bytesRead: number,
	totalBytes: number,
	alreadyTruncated: boolean,
	limit: number,
): TabularPreview {
	const warnings: string[] = [];
	const records = values.filter(isRecord);
	if (records.length !== values.length) {
		return boundTable({
			kind: 'tabular',
			format,
			columns: [{ name: 'value' }],
			rows: values.slice(0, limit).map((value) => [normalizeValue(value, warnings)]),
			truncated: alreadyTruncated || values.length > limit,
			bytes_read: bytesRead,
			total_bytes: totalBytes,
			warnings,
		});
	}
	const columns: string[] = [];
	const seen = new Set<string>();
	for (const record of records) {
		for (const key of Object.keys(record)) {
			if (!seen.has(key) && columns.length < MAX_COLUMNS) {
				seen.add(key);
				columns.push(key);
			}
		}
	}
	return boundTable({
		kind: 'tabular',
		format,
		columns: columns.map((name) => ({ name })),
		rows: records
			.slice(0, limit)
			.map((record) => columns.map((column) => normalizeValue(record[column], warnings))),
		truncated: alreadyTruncated || values.length > limit,
		bytes_read: bytesRead,
		total_bytes: totalBytes,
		warnings,
	});
}

function previewText(
	bytes: Uint8Array,
	totalBytes: number,
	format: 'text' | 'markdown' | 'code' | 'log',
): ObjectPreview {
	const source = bytes.slice(0, MAX_TEXT_BYTES);
	return {
		kind: 'text',
		format,
		text: decodeUtf8(source, source.byteLength < totalBytes),
		truncated: source.byteLength < totalBytes,
		bytes_read: bytes.byteLength,
		total_bytes: totalBytes,
		warnings: [],
	};
}

async function previewParquet(
	reader: ObjectPreviewReader,
	limits: ObjectBrowserLimits,
	request: ObjectPreviewRequest,
	head: ObjectPreviewHead,
	signal: AbortSignal,
): Promise<TabularPreview> {
	const total = head.total_bytes;
	let requests = 0;
	let bytesRead = 0;
	const cache = new Map<string, Promise<ArrayBuffer>>();
	const file: AsyncBuffer = {
		byteLength: total,
		slice(start, end = total) {
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				end <= start ||
				end > total
			) {
				return Promise.reject(
					new ObjectBrowseError('unsupported', 'The Parquet reader requested an invalid range.'),
				);
			}
			const key = `${start}:${end}`;
			const cached = cache.get(key);
			if (cached) return cached;
			const length = end - start;
			if (requests >= MAX_PARQUET_REQUESTS || bytesRead + length > limits.parquetMaxRangedBytes) {
				return Promise.reject(
					new ObjectBrowseError('unsupported', 'The Parquet preview exceeded its range budget.'),
				);
			}
			requests += 1;
			bytesRead += length;
			const pending = reader
				.readRange(request, start, end, {
					etag: head.etag,
					signal,
				})
				.then(arrayBuffer);
			cache.set(key, pending);
			return pending;
		},
	};
	try {
		const metadata = await parquetMetadataAsync(file);
		const columns = parquetSchema(metadata)
			.children.slice(0, MAX_COLUMNS)
			.map((column) => column.element.name);
		const objects = await parquetReadObjects({
			file,
			metadata,
			columns,
			rowEnd: request.limit,
		});
		const warnings: string[] = [];
		return boundTable({
			kind: 'tabular',
			format: 'parquet',
			columns: columns.map((name) => ({ name })),
			rows: objects.map((row) => columns.map((column) => normalizeValue(row[column], warnings))),
			truncated:
				BigInt(request.limit) < metadata.num_rows ||
				columns.length < parquetSchema(metadata).children.length,
			bytes_read: bytesRead,
			total_bytes: total,
			warnings,
		});
	} catch (error) {
		if (error instanceof ObjectBrowseError) throw error;
		throw new ObjectBrowseError('unsupported', 'The Parquet file could not be previewed.');
	}
}

function decodeUtf8(bytes: Uint8Array, allowIncompleteTrailing = false): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes, {
			stream: allowIncompleteTrailing,
		});
	} catch {
		throw new ObjectBrowseError('unsupported', 'The object is not valid UTF-8 text.');
	}
}

function detectDelimiter(bytes: Uint8Array, truncated: boolean): ',' | '\t' | ';' {
	const prefix = bytes.slice(0, Math.min(bytes.length, 64 * 1024));
	const text = decodeUtf8(prefix, truncated || prefix.byteLength < bytes.byteLength);
	const counts = new Map<',' | '\t' | ';', number>([
		[',', 0],
		['\t', 0],
		[';', 0],
	]);
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char === '"') {
			if (quoted && text[index + 1] === '"') index += 1;
			else quoted = !quoted;
		} else if (!quoted && char === '\n') break;
		else if (!quoted && counts.has(char as ',' | '\t' | ';')) {
			const delimiter = char as ',' | '\t' | ';';
			counts.set(delimiter, counts.get(delimiter)! + 1);
		}
	}
	return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? ',';
}

function normalizeHeaders(values: unknown[]): string[] {
	const seen = new Map<string, number>();
	return values.map((value, index) => {
		const base = scalarText(value).trim() || `column_${index + 1}`;
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		return count === 1 ? base : `${base}_${count}`;
	});
}

function normalizeRow(row: unknown[], warnings: string[]): unknown[] {
	return row.map((value) => normalizeValue(value, warnings));
}

function normalizeValue(value: unknown, warnings: string[], depth = 0): unknown {
	if (value === null || value === undefined || typeof value === 'boolean') return value ?? null;
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'number') {
		if (Number.isFinite(value)) return value;
		warnings.push('Some non-finite numbers were converted to strings.');
		return String(value);
	}
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Uint8Array || value instanceof ArrayBuffer) return '[binary value]';
	if (depth >= 5) return '[nested value truncated]';
	if (typeof value === 'object') {
		const normalized = Array.isArray(value)
			? value.slice(0, 100).map((child) => normalizeValue(child, warnings, depth + 1))
			: Object.fromEntries(
					Object.entries(value as Record<string, unknown>)
						.slice(0, 100)
						.map(([key, child]) => [key, normalizeValue(child, warnings, depth + 1)]),
				);
		return truncateCell(JSON.stringify(normalized), warnings);
	}
	return truncateCell(scalarText(value), warnings);
}

function truncateCell(value: string, warnings: string[]): string {
	const bytes = new TextEncoder().encode(value);
	if (bytes.length <= MAX_CELL_BYTES) return value;
	warnings.push('Some values were truncated to 8 KiB.');
	return `${new TextDecoder().decode(bytes.slice(0, MAX_CELL_BYTES))}…`;
}

function scalarText(value: unknown): string {
	if (value === null || value === undefined) return '';
	switch (typeof value) {
		case 'undefined':
			return '';
		case 'string':
			return value;
		case 'number':
		case 'bigint':
		case 'boolean':
			return value.toString();
		case 'symbol':
			return value.description ?? '';
		case 'function':
			return '[function]';
		case 'object':
			return JSON.stringify(value);
		default:
			return '[unknown]';
	}
}

function boundTable(preview: TabularPreview): TabularPreview {
	preview.warnings = [...new Set(preview.warnings)];
	if (serializedByteLength(preview) <= MAX_RESULT_BYTES) return preview;
	const rows = preview.rows;
	preview.truncated = true;
	let lower = 0;
	let upper = rows.length;
	while (lower < upper) {
		const candidate = Math.ceil((lower + upper) / 2);
		preview.rows = rows.slice(0, candidate);
		if (serializedByteLength(preview) <= MAX_RESULT_BYTES) lower = candidate;
		else upper = candidate - 1;
	}
	preview.rows = rows.slice(0, lower);
	if (serializedByteLength(preview) > MAX_RESULT_BYTES) {
		throw new ObjectBrowseError('unsupported', 'The preview result exceeds the response limit.');
	}
	return preview;
}

function serializedByteLength(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function unsupported(reason: string, type: string | undefined, totalBytes: number): ObjectPreview {
	return {
		kind: 'unsupported',
		reason,
		detected_type: type,
		total_bytes: totalBytes,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CODE_EXTENSIONS = new Set([
	'py',
	'ts',
	'tsx',
	'js',
	'jsx',
	'css',
	'sql',
	'sh',
	'yaml',
	'yml',
	'toml',
	'xml',
]);
const TEXT_EXTENSIONS = new Set(['txt', 'text', 'conf', 'ini']);
const ACTIVE_CONTENT_TYPES = new Set([
	'text/html',
	'application/xhtml+xml',
	'image/svg+xml',
	'application/pdf',
]);
