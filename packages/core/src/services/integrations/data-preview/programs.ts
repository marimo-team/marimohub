import type { IntegrationId, ProjectId, SessionId, UserId } from '../../../ids';
import type { TablePreview } from '../../../ports/integrations';
import type { RenderOutput } from '../sdk';

export type PreviewRuntimeFeature = 'iceberg-http';
export type PreviewCredentialVars =
	| Record<string, string>
	| (() => Promise<Record<string, string> | undefined>);

export interface DuckDBPreviewStatement {
	text: string;
	params?: readonly DuckDBPreviewParameter[];
}

export type DuckDBPreviewParameter = string | number | boolean | null;

export interface DuckDBPreviewProgram {
	setup: readonly DuckDBPreviewStatement[];
	query: DuckDBPreviewStatement;
	cleanup?: readonly DuckDBPreviewStatement[];
	requires?: readonly PreviewRuntimeFeature[];
}

export interface PythonPreviewProgram {
	script: string;
	input: unknown;
	maxRows: number;
	render: RenderOutput;
	integration: {
		id: IntegrationId;
		name: string;
		kind: string;
		version: number;
	};
	sessionId: SessionId;
	credentialVars?: PreviewCredentialVars;
}

export interface PreviewPrograms {
	duckdbWasm?: DuckDBPreviewProgram;
	python?: PythonPreviewProgram;
}

export interface PreviewProgramAvailability {
	duckdbWasm?: readonly PreviewRuntimeFeature[];
	python?: boolean;
}

export interface PreviewProgramInput<C> {
	config: C;
	integration: PythonPreviewProgram['integration'];
	projectId: ProjectId;
	principal: { userId: UserId; email: string };
	sessionId: SessionId;
	namespace: string[];
	table: string;
	limit: number;
	credentialVars?: PreviewCredentialVars;
}

export interface PreviewExecutorStatus {
	available: boolean;
	runtime?: 'worker' | 'inline' | 'sandbox';
	features?: readonly PreviewRuntimeFeature[];
}

export interface DuckDBWasmRuntime {
	readonly mode: 'worker' | 'inline';
	readonly features: readonly PreviewRuntimeFeature[];
	initialize(options: { memoryLimitMb: number }): Promise<void>;
	execute(program: DuckDBPreviewProgram): Promise<TablePreview>;
	ping(): Promise<void>;
	close(): Promise<void>;
}

export type DuckDBWasmRuntimeFactory = () => Promise<DuckDBWasmRuntime>;
