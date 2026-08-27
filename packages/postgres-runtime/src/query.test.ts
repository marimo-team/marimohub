import { describe, expect, it } from 'vitest';
import { postgresQuery, postgresQuerySql, PostgresStatementTypeError } from './query';

describe('postgresQuerySql', () => {
	it('removes a trailing statement terminator before wrapping the query', () => {
		expect(postgresQuerySql('SELECT 1;', 10)).toBe(
			'SELECT * FROM (SELECT 1\n) AS "__marimohub_query" LIMIT 11',
		);
	});

	it('preserves semicolons inside PostgreSQL literals', () => {
		expect(postgresQuerySql("SELECT ';' AS value;", 1)).toContain("SELECT ';' AS value\n");
	});

	it('accepts SELECT and WITH after PostgreSQL comments', () => {
		expect(
			postgresQuerySql(
				'/* outer /* nested */ */ WITH values AS (SELECT 1) SELECT * FROM values',
				1,
			),
		).toContain('WITH values');
		expect(postgresQuerySql('-- comment\nSELECT 1', 1)).toContain('SELECT 1');
	});

	it.each([
		'DELETE FROM things',
		'INSERT INTO things VALUES (1)',
		'UPDATE things SET id = 2',
		'MERGE INTO things USING source ON false WHEN NOT MATCHED THEN INSERT DEFAULT VALUES',
		'COPY things TO STDOUT',
		'CREATE TABLE things (id int)',
		'BEGIN',
		'TABLE things',
		'VALUES (1)',
	])('rejects direct mutation before execution: %s', (sql) =>
		expect(() => postgresQuerySql(sql, 1)).toThrow(PostgresStatementTypeError),
	);

	it('reports the leading offset removed by statement normalization', () => {
		expect(postgresQuery(' \n\tSELECT broken', 1).leadingOffset).toBe(3);
		expect(postgresQuery(' ; \n SELECT broken', 1).leadingOffset).toBe(5);
	});
});
