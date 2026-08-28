import type {
	BrowsePage,
	DataQueryResult,
	PostgresConnectionCapability,
	TablePreview,
	TableSchema,
} from '@marimo-hub/core';

export interface PinnedAddress {
	address: string;
	family: number;
}

export type PostgresOperation =
	| { type: 'test' }
	| { type: 'namespaces'; after?: string; limit: number }
	| { type: 'tables'; schema: string; after?: string; limit: number }
	| { type: 'schema'; schema: string; table: string }
	| {
			type: 'preview';
			schema: string;
			table: string;
			limit: number;
			maxBytes: number;
	  }
	| {
			type: 'query';
			sql: string;
			maxRows: number;
			maxBytes: number;
			deadlineMs: number;
	  };

export interface PostgresWorkerRequest {
	id: number;
	connection: PostgresConnectionCapability;
	pinned: PinnedAddress[];
	operation: PostgresOperation;
}

export type PostgresWorkerValue =
	| { connected: true }
	| BrowsePage<string[]>
	| BrowsePage<string>
	| TableSchema
	| TablePreview
	| DataQueryResult;

export type PostgresFailureCode =
	| 'target_denied'
	| 'authentication'
	| 'tls'
	| 'connection'
	| 'timeout'
	| 'query_rejected'
	| 'malformed_result'
	| 'worker_failure';

export interface PostgresWorkerFailure {
	code: PostgresFailureCode;
	reason?: 'statement_type';
	sqlState?: string;
	position?: number;
}

export type PostgresWorkerResponse =
	| { id: number; ok: true; value: PostgresWorkerValue }
	| ({ id: number; ok: false } & PostgresWorkerFailure);
