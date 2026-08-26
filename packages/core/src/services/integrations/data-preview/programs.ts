import type { ProjectId, SessionId, UserId } from '../../../ids';
import type { IntegrationVersionPin, TablePreview } from '../../../ports/integrations';
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

export interface DuckDBHttpAccess {
	kind: 'iceberg-rest';
	catalog: {
		url: string;
		authorization?: string;
	};
	storage:
		| {
				kind: 's3';
				endpoint: string;
				region: string;
				urlStyle: 'path' | 'vhost';
				credentials:
					| { method: 'anonymous' }
					| {
							method: 'static';
							accessKeyId: string;
							secretAccessKey: string;
							sessionToken?: string;
					  };
				locations: readonly { bucket: string; prefix: string }[];
		  }
		| {
				kind: 'r2-catalog';
				endpoint: string;
				bucket: string;
		  };
}

export interface DuckDBPreviewProgram {
	setup: readonly DuckDBPreviewStatement[];
	query: DuckDBPreviewStatement;
	cleanup?: readonly DuckDBPreviewStatement[];
	requires?: readonly PreviewRuntimeFeature[];
	httpAccess?: Readonly<DuckDBHttpAccess>;
}

export interface PythonPreviewProgram {
	script: string;
	input: unknown;
	maxRows: number;
	render: RenderOutput;
	integration: IntegrationVersionPin;
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
	execute(program: DuckDBPreviewProgram, signal?: AbortSignal): Promise<TablePreview>;
	ping(): Promise<void>;
	close(): Promise<void>;
}

export type DuckDBWasmRuntimeFactory = () => Promise<DuckDBWasmRuntime>;
