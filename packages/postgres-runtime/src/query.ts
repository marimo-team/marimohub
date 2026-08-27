import { singleDataQueryStatement } from '@marimo-hub/core/data-query-sql';

export const QUERY_WRAPPER_PREFIX = 'SELECT * FROM (';

export interface PostgresWrappedQuery {
	sql: string;
	leadingOffset: number;
}

export class PostgresStatementTypeError extends Error {
	override readonly name = 'PostgresStatementTypeError';
}

export function postgresQuery(sql: string, maxRows: number): PostgresWrappedQuery {
	const statement = singleDataQueryStatement(sql);
	const keyword = firstKeyword(statement);
	if (keyword !== 'SELECT' && keyword !== 'WITH') throw new PostgresStatementTypeError();
	return {
		sql: `${QUERY_WRAPPER_PREFIX}${statement}\n) AS "__marimohub_query" LIMIT ${maxRows + 1}`,
		leadingOffset: codePointLength(sql.slice(0, Math.max(0, sql.indexOf(statement)))),
	};
}

export function postgresQuerySql(sql: string, maxRows: number): string {
	return postgresQuery(sql, maxRows).sql;
}

function codePointLength(value: string): number {
	let length = 0;
	for (const _character of value) length++;
	return length;
}

function firstKeyword(statement: string): string {
	let index = 0;
	while (index < statement.length) {
		while (/\s/u.test(statement[index] ?? '')) index++;
		if (statement.startsWith('--', index)) {
			const newline = statement.indexOf('\n', index + 2);
			if (newline === -1) return '';
			index = newline + 1;
			continue;
		}
		if (statement.startsWith('/*', index)) {
			let depth = 1;
			index += 2;
			while (depth > 0 && index < statement.length) {
				if (statement.startsWith('/*', index)) {
					depth++;
					index += 2;
				} else if (statement.startsWith('*/', index)) {
					depth--;
					index += 2;
				} else {
					index++;
				}
			}
			if (depth > 0) return '';
			continue;
		}
		break;
	}
	return /^[A-Za-z]+/u.exec(statement.slice(index))?.[0]?.toUpperCase() ?? '';
}
