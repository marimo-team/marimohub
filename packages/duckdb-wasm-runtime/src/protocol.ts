import type { DataQueryExecution, DuckDBPreviewProgram } from '@marimo-hub/core';

export type RuntimeRequest =
	| { id: number; type: 'initialize'; memoryLimitMb: number }
	| { id: number; type: 'execute'; program: DuckDBPreviewProgram }
	| { id: number; type: 'execute-query'; request: DataQueryExecution }
	| { id: number; type: 'ping' };

export type RuntimeResponse =
	| { id: number; ok: true; value?: unknown }
	| { id: number; ok: false; error: string };

export type RuntimeRequestInput =
	| { type: 'initialize'; memoryLimitMb: number }
	| { type: 'execute'; program: DuckDBPreviewProgram }
	| { type: 'execute-query'; request: DataQueryExecution }
	| { type: 'ping' };
