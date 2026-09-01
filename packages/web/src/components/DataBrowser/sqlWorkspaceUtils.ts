import type { EditorState } from '@codemirror/state';

export type QueryDialect = 'duckdb' | 'postgresql';

export interface SqlTarget {
	from: number;
	to: number;
	sql: string;
	document: string;
}

export function sqlDialectSettings(dialect: QueryDialect) {
	return dialect === 'postgresql'
		? ({
				parserDatabase: 'PostgreSQL',
				formatterLanguage: 'postgresql',
				name: 'PostgreSQL',
			} as const)
		: ({ parserDatabase: 'DuckDB', formatterLanguage: 'duckdb', name: 'DuckDB' } as const);
}

export function defaultSql(dialect: QueryDialect): string {
	const { name } = sqlDialectSettings(dialect);
	return `-- Select a table or write a ${name} query\nSELECT 1 AS ready;`;
}

export function completionSchemaSummary(counts: {
	tables: number;
	discovered_tables: number;
	columns: number;
	discovery_complete: boolean;
}): string {
	const discovered = counts.discovery_complete
		? `${counts.discovered_tables}`
		: `${counts.discovered_tables}+`;
	const tables = counts.discovered_tables === 1 && counts.discovery_complete ? 'table' : 'tables';
	const columns = counts.columns === 1 ? 'column' : 'columns';
	return (
		`Loaded ${counts.tables} of ${discovered} ${tables} (${counts.columns} ${columns}) for autocomplete. ` +
		'The selected table is always included, and queries against omitted tables still run.'
	);
}

export function selectedOrCurrentStatement(state: EditorState): string {
	return sqlTargetAtState(state).sql;
}

export function sqlTargetAtState(state: EditorState): SqlTarget {
	const document = state.doc.toString();
	const selection = state.selection.main;
	if (state.sliceDoc(selection.from, selection.to).trim()) {
		return {
			from: selection.from,
			to: selection.to,
			sql: state.sliceDoc(selection.from, selection.to),
			document,
		};
	}
	const range = sqlStatementRangeAtCursor(document, selection.head);
	let from = range.from;
	let to = range.to;
	while (from < to && /\s/.test(document[from])) from++;
	while (to > from && /\s/.test(document[to - 1])) to--;
	if (document[to - 1] === ';') to--;
	return { from, to, sql: document.slice(from, to).trim(), document };
}

export function applySqlTarget(
	document: string,
	target: SqlTarget,
	replacement: string,
): string | undefined {
	if (document !== target.document) return undefined;
	return `${document.slice(0, target.from)}${replacement}${document.slice(target.to)}`;
}

function sqlStatementRangeAtCursor(sql: string, cursor: number): { from: number; to: number } {
	const ranges = sqlStatementRanges(sql);
	for (const range of ranges) {
		if (cursor <= range.to) return range;
	}
	return ranges.at(-1) ?? { from: 0, to: sql.length };
}

function isIdentifierContinuation(character: string | undefined): boolean {
	return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function isEscapeStringPrefix(sql: string, quoteIndex: number): boolean {
	const prefix = sql[quoteIndex - 1];
	return (prefix === 'E' || prefix === 'e') && !isIdentifierContinuation(sql[quoteIndex - 2]);
}

function sqlStatementRanges(sql: string): { from: number; to: number }[] {
	let start = 0;
	const ranges: { from: number; to: number }[] = [];
	let hasToken = false;
	let mode:
		| 'normal'
		| 'single'
		| 'escape-single'
		| 'double'
		| 'backtick'
		| 'line-comment'
		| 'block-comment' = 'normal';
	let blockDepth = 0;
	let dollarDelimiter: string | undefined;
	for (let index = 0; index < sql.length; index++) {
		const character = sql[index];
		const next = sql[index + 1];
		if (dollarDelimiter !== undefined) {
			if (sql.startsWith(dollarDelimiter, index)) {
				index += dollarDelimiter.length - 1;
				dollarDelimiter = undefined;
			}
			continue;
		}
		if (mode === 'line-comment') {
			if (character === '\n' || character === '\r') mode = 'normal';
			continue;
		}
		if (mode === 'block-comment') {
			if (character === '/' && next === '*') {
				blockDepth++;
				index++;
			} else if (character === '*' && next === '/') {
				blockDepth--;
				index++;
				if (blockDepth === 0) mode = 'normal';
			}
			continue;
		}
		if (mode !== 'normal') {
			if (mode === 'escape-single' && character === '\\') {
				index++;
				continue;
			}
			const quote =
				mode === 'single' || mode === 'escape-single' ? "'" : mode === 'double' ? '"' : '`';
			if (character === quote) {
				if (next === quote) index++;
				else mode = 'normal';
			}
			continue;
		}
		if (character === '-' && next === '-') {
			mode = 'line-comment';
			index++;
			continue;
		}
		if (character === '/' && next === '*') {
			mode = 'block-comment';
			blockDepth = 1;
			index++;
			continue;
		}
		if (character === "'" || character === '"' || character === '`') {
			hasToken = true;
			mode =
				character === "'"
					? isEscapeStringPrefix(sql, index)
						? 'escape-single'
						: 'single'
					: character === '"'
						? 'double'
						: 'backtick';
			continue;
		}
		if (character === '$' && !isIdentifierContinuation(sql[index - 1])) {
			const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
			if (delimiter !== undefined) {
				hasToken = true;
				dollarDelimiter = delimiter;
				index += delimiter.length - 1;
				continue;
			}
		}
		if (character === ';') {
			if (hasToken) ranges.push({ from: start, to: index + 1 });
			start = index + 1;
			hasToken = false;
		} else if (!/\s/.test(character)) {
			hasToken = true;
		}
	}
	if (hasToken) ranges.push({ from: start, to: sql.length });
	return ranges;
}

export function allSqlStatements(sql: string): string[] {
	return sqlStatementRanges(sql).map(({ from, to }) => sql.slice(from, to).trim());
}

function renderCell(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return '[unserializable]';
	}
}

export function csvCell(value: unknown): string {
	const rendered = renderCell(value);
	const text =
		typeof value === 'string' && /^[\t\r ]*[=+\-@]/.test(rendered) ? `'${rendered}` : rendered;
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
