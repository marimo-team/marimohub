import type { IntegrationVersionPin } from '../../../ports/integrations';
import type { DuckDBHttpAccess } from '../data-preview/programs';
import type { PostgresConnectionCapability } from '../../../ports/databaseBrowser';

export type DataQueryEngine = 'duckdb-wasm' | 'postgres';

export interface DataQueryResult {
	columns: string[];
	rows: unknown[][];
	truncated: boolean;
	execution_ms?: number;
}

export interface DataQueryStatement {
	text: string;
	params?: readonly (string | number | boolean | null)[];
}

export interface DuckDBDataQueryPlan {
	engine?: 'duckdb-wasm';
	setup: readonly DataQueryStatement[];
	cleanup?: readonly DataQueryStatement[];
	httpAccess?: Readonly<DuckDBHttpAccess>;
}

export interface PostgresDataQueryPlan {
	engine: 'postgres';
	connection: Readonly<PostgresConnectionCapability>;
	setup?: never;
	cleanup?: never;
	httpAccess?: never;
}

export type DataQueryPlan = DuckDBDataQueryPlan | PostgresDataQueryPlan;

export interface DataQueryConnection {
	/** Ephemeral secret-bearing material for this request; executors must never persist or log it. */
	readonly files: readonly { readonly path: string; readonly content: string }[];
	readonly vars: Readonly<Record<string, string>>;
	readonly integration: Readonly<IntegrationVersionPin>;
	readonly plan?: Readonly<DataQueryPlan>;
}

/**
 * A query failure attributable to the user's SQL (parse, bind, catalog, or
 * result-limit). Executors throw it only for messages vetted as safe to
 * surface; the service still redacts connection secrets before doing so.
 */
export class DataQueryUserError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'DataQueryUserError';
	}
}

export interface DataQueryExecution {
	sql: string;
	connection: DataQueryConnection;
	accessMode: 'read-only';
	limits: {
		maxRows: number;
		maxBytes: number;
		deadlineMs: number;
	};
}

/** A fresh executor is created and hard-terminated for every query. */
export interface DisposableDataQueryExecutor {
	readonly runtime: 'worker' | 'process';
	execute(request: DataQueryExecution, signal: AbortSignal): Promise<DataQueryResult>;
	/** Must synchronously initiate termination of the worker or process. */
	terminate(): void;
}

export interface DataQueryExecutorFactory {
	/** Creation must reject promptly when the signal is aborted. */
	create(signal: AbortSignal): Promise<DisposableDataQueryExecutor>;
}
