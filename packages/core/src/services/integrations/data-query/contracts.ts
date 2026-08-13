import type { IntegrationVersionPin } from '../../../ports/integrations';

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

export interface DataQueryPlan {
	setup: readonly DataQueryStatement[];
	cleanup?: readonly DataQueryStatement[];
}

export interface DataQueryConnection {
	/** Ephemeral secret-bearing material for this request; executors must never persist or log it. */
	readonly files: readonly { readonly path: string; readonly content: string }[];
	readonly vars: Readonly<Record<string, string>>;
	readonly integration: Readonly<IntegrationVersionPin>;
	readonly plan?: Readonly<DataQueryPlan>;
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
