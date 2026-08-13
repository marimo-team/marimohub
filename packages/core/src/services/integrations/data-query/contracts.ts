import type { IntegrationVersionPin } from '../../../ports/integrations';

export interface DataQueryResult {
	columns: string[];
	rows: unknown[][];
	truncated: boolean;
}

export interface DataQueryConnection {
	/** Ephemeral secret-bearing material for this request; executors must never persist or log it. */
	readonly files: readonly { readonly path: string; readonly content: string }[];
	readonly vars: Readonly<Record<string, string>>;
	readonly integration: Readonly<IntegrationVersionPin>;
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
