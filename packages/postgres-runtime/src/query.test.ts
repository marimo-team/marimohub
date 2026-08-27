import { describe, expect, it } from 'vitest';
import { postgresQuerySql } from './query';

describe('postgresQuerySql', () => {
	it('removes a trailing statement terminator before wrapping the query', () => {
		expect(postgresQuerySql('SELECT 1;', 10)).toBe(
			'SELECT * FROM (SELECT 1\n) AS "__marimohub_query" LIMIT 11',
		);
	});

	it('preserves semicolons inside PostgreSQL literals', () => {
		expect(postgresQuerySql("SELECT ';' AS value;", 1)).toContain("SELECT ';' AS value\n");
	});
});
