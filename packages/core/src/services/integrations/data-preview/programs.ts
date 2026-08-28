import type { ProjectId, SessionId, UserId } from '../../../ids';
import type { IntegrationVersionPin, TablePreview } from '../../../ports/integrations';
import type { RenderOutput } from '../sdk';

export type PreviewRuntimeFeature = 'guarded-http' | 'iceberg-http' | 'vended-s3-routes';
export type PreviewCredentialVars =
	| Record<string, string>
	| (() => Promise<Record<string, string> | undefined>);

export interface DuckDBPreviewStatement {
	text: string;
	params?: readonly DuckDBPreviewParameter[];
}

export type DuckDBPreviewParameter = string | number | boolean | null;

export type DuckDBS3Credentials =
	| { method: 'anonymous' }
	| {
			method: 'static';
			accessKeyId: string;
			secretAccessKey: string;
			sessionToken?: string;
	  };

interface DuckDBHttpTransportPolicy {
	allowInsecureTransport?: boolean;
}

export interface DuckDBS3StorageAccess {
	endpoint: string;
	region: string;
	urlStyle: 'path' | 'vhost';
	credentials: DuckDBS3Credentials;
	locations: readonly { bucket: string; prefix: string }[];
}

export interface DuckDBS3HttpAccess extends DuckDBHttpTransportPolicy, DuckDBS3StorageAccess {
	kind: 's3-object-store';
}

export interface DuckDBIcebergRestHttpAccess extends DuckDBHttpTransportPolicy {
	kind: 'iceberg-rest';
	catalog: {
		url: string;
		authorization?: string;
		oauth2?: {
			tokenEndpoint: string;
			clientId: string;
			clientSecret: string;
			scope: string;
			refreshMarginSeconds: number;
			fallbackExpiresInSeconds?: number;
		};
	};
	storage:
		| ({
				kind: 's3';
		  } & DuckDBS3StorageAccess)
		| {
				kind: 'r2-catalog';
				endpoint: string;
				bucket: string;
		  }
		| {
				kind: 'vended-s3';
				endpoint: string;
				region: string;
				urlStyle: 'path' | 'vhost';
				allowedLocations: readonly { bucket: string; prefix: string }[];
		  };
}

export interface DuckDBDatabaseHttpAccess {
	kind: 'http-database';
	url: string;
	authorization?: string;
}

export interface DuckDBDuckLakeHttpAccess extends DuckDBHttpTransportPolicy {
	kind: 'ducklake';
	metadata: DuckDBDatabaseHttpAccess;
	storage: DuckDBS3StorageAccess;
}

export type DuckDBHttpAccess =
	| DuckDBDatabaseHttpAccess
	| DuckDBDuckLakeHttpAccess
	| DuckDBIcebergRestHttpAccess
	| DuckDBS3HttpAccess;

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
