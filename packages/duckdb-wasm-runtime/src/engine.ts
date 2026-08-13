import { fileURLToPath } from 'node:url';
import * as duckdb from '@duckdb/duckdb-wasm/blocking';
import type {
	DataQueryExecution,
	DataQueryResult,
	DuckDBPreviewProgram,
	TablePreview,
} from '@marimo-hub/core';
import { createFailClosedNodeRuntime } from './networkPolicy.ts';
import { singleStatement } from './sql.ts';

const MAX_RESULT_BYTES = 2 * 1024 * 1024;

type Database = Awaited<ReturnType<typeof duckdb.createDuckDB>>;

export class BlockingDuckDBEngine {
	private db: Database | undefined;

	async initialize(memoryLimitMb: number): Promise<void> {
		if (this.db) return;
		const mainModule = modulePath();
		const db = await duckdb.createDuckDB(
			{
				eh: { mainModule, mainWorker: '' },
				mvp: { mainModule, mainWorker: '' },
			},
			new duckdb.VoidLogger(),
			createFailClosedNodeRuntime(),
		);
		await db.instantiate();
		db.open({ path: ':memory:' });
		const connection = db.connect();
		try {
			runStatement(connection, { text: 'SET memory_limit = ?', params: [`${memoryLimitMb}MB`] });
			connection.query('SET allow_community_extensions=false');
			connection.query('SET autoinstall_known_extensions=false');
			connection.query('SET autoload_known_extensions=false');
			connection.query('SET enable_external_access=false');
			connection.query('SET lock_configuration=true');
			connection.query('SELECT 1');
		} catch (error) {
			db.reset();
			throw error;
		} finally {
			connection.close();
		}
		this.db = db;
	}

	ping(): void {
		const connection = this.requireDatabase().connect();
		try {
			connection.query('SELECT 1');
		} finally {
			connection.close();
		}
	}

	execute(program: DuckDBPreviewProgram): TablePreview {
		const connection = this.requireDatabase().connect();
		let primaryError: unknown;
		let cleanupError: unknown;
		let transactionOpen = false;
		let preview: TablePreview | undefined;
		try {
			for (const statement of program.setup) runStatement(connection, statement);
			connection.query('BEGIN TRANSACTION READ ONLY');
			transactionOpen = true;
			const result = runStatement(connection, program.query);
			preview = normalizeResult(result);
		} catch (error) {
			primaryError = error;
		} finally {
			try {
				if (transactionOpen) connection.query('ROLLBACK');
				for (const statement of [...(program.cleanup ?? [])].reverse()) {
					runStatement(connection, statement);
				}
			} catch (error) {
				if (transactionOpen) {
					try {
						connection.query('ROLLBACK');
					} catch {}
				}
				cleanupError = error;
			} finally {
				connection.close();
			}
		}
		if (primaryError !== undefined) throw asError(primaryError);
		if (cleanupError !== undefined) throw asError(cleanupError);
		if (!preview) throw new Error('DuckDB-Wasm did not return a preview result.');
		return preview;
	}

	async executeQuery(request: DataQueryExecution): Promise<DataQueryResult> {
		const plan = request.connection.plan;
		const statement = singleStatement(request.sql);
		const maxRows = request.limits.maxRows;
		if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error('Invalid query row limit.');
		const connection = this.requireDatabase().connect();
		let primaryError: unknown;
		let cleanupError: unknown;
		let transactionOpen = false;
		let queryResult: DataQueryResult | undefined;
		try {
			for (const setup of plan?.setup ?? []) runStatement(connection, setup);
			connection.query('BEGIN TRANSACTION READ ONLY');
			transactionOpen = true;
			const result = await connection.send(
				`SELECT * FROM (${statement}) AS "__marimohub_query" LIMIT ${maxRows + 1}`,
				true,
			);
			result.open();
			queryResult = normalizeQueryResultStream(result, maxRows, request.limits.maxBytes);
		} catch (error) {
			primaryError = error;
		} finally {
			try {
				if (transactionOpen) connection.query('ROLLBACK');
				for (const cleanup of [...(plan?.cleanup ?? [])].reverse()) {
					runStatement(connection, cleanup);
				}
			} catch (error) {
				if (transactionOpen) {
					try {
						connection.query('ROLLBACK');
					} catch {}
				}
				cleanupError = error;
			} finally {
				connection.close();
			}
		}
		if (primaryError !== undefined) throw asError(primaryError);
		if (cleanupError !== undefined) throw asError(cleanupError);
		if (!queryResult) throw new Error('DuckDB-Wasm did not return a query result.');
		return queryResult;
	}

	close(): void {
		this.db?.reset();
		this.db = undefined;
	}

	private requireDatabase(): Database {
		if (!this.db) throw new Error('DuckDB-Wasm is not initialized.');
		return this.db;
	}
}

type Connection = ReturnType<Database['connect']>;

function runStatement(
	connection: Connection,
	statement: DuckDBPreviewProgram['query'],
): ReturnType<Connection['query']> {
	if (!statement.params || statement.params.length === 0) return connection.query(statement.text);
	const prepared = connection.prepare(statement.text);
	try {
		return prepared.query(...statement.params);
	} finally {
		prepared.close();
	}
}

function modulePath(): string {
	return import.meta.url.endsWith('.ts')
		? fileURLToPath(import.meta.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'))
		: fileURLToPath(new URL('./duckdb-eh.wasm', import.meta.url));
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error('DuckDB-Wasm execution failed.');
}

function normalizeResult(
	result: ReturnType<ReturnType<Database['connect']>['query']>,
): TablePreview {
	const columns = result.schema.fields.map((field) => field.name);
	const dateColumns = result.schema.fields.map((field) => field.type.typeId === 8);
	const rows = result.toArray().map((row) => {
		const record = row.toJSON() as Record<string, unknown>;
		return columns.map((column, index) => jsonValue(record[column], dateColumns[index]));
	});
	const preview = { columns, rows };
	if (new TextEncoder().encode(JSON.stringify(preview)).byteLength > MAX_RESULT_BYTES) {
		throw new Error('DuckDB-Wasm result exceeded the response limit.');
	}
	return preview;
}

function normalizeQueryResultStream(
	result: Awaited<ReturnType<ReturnType<Database['connect']>['send']>>,
	maxRows: number,
	maxBytes: number,
): DataQueryResult {
	const columns = result.schema.fields.map((field) => field.name);
	const dateColumns = result.schema.fields.map((field) => field.type.typeId === 8);
	const rows: unknown[][] = [];
	let truncated = false;
	let stopped = false;
	if (queryResponseBytes(columns, rows, truncated) > maxBytes) {
		result.cancel();
		throw new Error('DuckDB-Wasm result exceeded the response limit.');
	}
	for (const batch of result) {
		for (const row of batch) {
			if (rows.length === maxRows) {
				truncated = true;
				stopped = true;
				break;
			}
			const record = row.toJSON() as Record<string, unknown>;
			rows.push(columns.map((column, index) => jsonValue(record[column], dateColumns[index])));
			if (queryResponseBytes(columns, rows, false) > maxBytes) {
				rows.pop();
				truncated = true;
				stopped = true;
				break;
			}
		}
		if (stopped) break;
	}
	if (stopped) result.cancel();
	if (queryResponseBytes(columns, rows, truncated) > maxBytes) {
		throw new Error('DuckDB-Wasm result exceeded the response limit.');
	}
	return { columns, rows, truncated };
}

function queryResponseBytes(columns: string[], rows: unknown[][], truncated: boolean): number {
	return new TextEncoder().encode(
		JSON.stringify({ columns, rows, truncated, execution_ms: Number.MAX_SAFE_INTEGER }),
	).byteLength;
}

function jsonValue(value: unknown, dateValue = false): unknown {
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'number' && dateValue) {
		return new Date(value).toISOString();
	}
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
	if (Array.isArray(value)) return value.map((item) => jsonValue(item));
	if (value && typeof value === 'object' && isIterable(value)) {
		return Array.from(value, (item) => jsonValue(item));
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, jsonValue(item)]),
		);
	}
	return value;
}

function isIterable(value: unknown): value is Iterable<unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		Symbol.iterator in value &&
		typeof value[Symbol.iterator] === 'function'
	);
}
