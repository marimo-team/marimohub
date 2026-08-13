// Sticky so the tag is matched in place at `lastIndex` — slicing the remainder
// at every '$' would make a '$'-heavy input quadratic.
const dollarQuoteTag = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;

// An E'...' escape string, where the prefix is its own token (so CASE'x' or
// TABLE'x' is not mistaken for one).
function isEscapeStringPrefix(sql: string, quoteIndex: number): boolean {
	const prefix = sql[quoteIndex - 1];
	if (prefix !== 'E' && prefix !== 'e') return false;
	const before = sql[quoteIndex - 2];
	return before === undefined || !/[A-Za-z0-9_$]/.test(before);
}

export function singleDataQueryStatement(sql: string): string {
	const statements: string[] = [];
	let start = 0;
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
			const quote =
				mode === 'single' || mode === 'escape-single' ? "'" : mode === 'double' ? '"' : '`';
			if (mode === 'escape-single' && character === '\\') {
				index++;
			} else if (character === quote) {
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
		if (character === '$') {
			dollarQuoteTag.lastIndex = index;
			const delimiter = dollarQuoteTag.exec(sql)?.[0];
			if (delimiter !== undefined) {
				hasToken = true;
				dollarDelimiter = delimiter;
				index += delimiter.length - 1;
				continue;
			}
		}
		if (character === ';') {
			if (hasToken) statements.push(sql.slice(start, index).trim());
			start = index + 1;
			hasToken = false;
			continue;
		}
		if (!/\s/.test(character)) hasToken = true;
	}
	if (hasToken) statements.push(sql.slice(start).trim());
	if (statements.length !== 1) throw new Error('SQL must contain exactly one statement.');
	return statements[0];
}
