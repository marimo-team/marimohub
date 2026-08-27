import { singleDataQueryStatement } from '@marimo-hub/core/data-query-sql';

export const QUERY_WRAPPER_PREFIX = 'SELECT * FROM (';

export function postgresQuerySql(sql: string, maxRows: number): string {
	const statement = singleDataQueryStatement(sql);
	return `${QUERY_WRAPPER_PREFIX}${statement}\n) AS "__marimohub_query" LIMIT ${maxRows + 1}`;
}
