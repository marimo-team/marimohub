import type {
	BrowseNamespacesRequest,
	BrowsePage,
	BrowsePageRequest,
	TablePreview,
	TablePreviewRequest,
	TableSchema,
	TestResult,
} from './integrations';

export type PostgresTlsCapability =
	| { mode: 'disable' | 'prefer' | 'require' }
	| {
			mode: 'verify-ca' | 'verify-full';
			ca: { kind: 'system' } | { kind: 'bundle'; pem: string };
	  };

export interface PostgresConnectionCapability {
	provider: 'postgres';
	host: string;
	port: number;
	database: string;
	username: string;
	password: string;
	tls: PostgresTlsCapability;
}

export type DatabaseSource = PostgresConnectionCapability;

export interface DatabaseTestOptions {
	/** Cancels the probe when the caller goes away (e.g. the HTTP request aborts). */
	signal?: AbortSignal;
}

export interface DatabaseConnectionTester {
	readonly provider: DatabaseSource['provider'];
	testConnection(source: DatabaseSource, options?: DatabaseTestOptions): Promise<TestResult>;
}

export type DatabaseConnectionTesterRegistry = Partial<
	Record<DatabaseSource['provider'], DatabaseConnectionTester>
>;

export interface DatabaseBrowser extends DatabaseConnectionTester {
	readonly preview: boolean;
	listNamespaces(
		source: DatabaseSource,
		request: BrowseNamespacesRequest,
	): Promise<BrowsePage<string[]>>;
	listTables(
		source: DatabaseSource,
		namespace: string[],
		request: BrowsePageRequest,
	): Promise<BrowsePage<string>>;
	getTableSchema(
		source: DatabaseSource,
		namespace: string[],
		table: string,
		request?: Pick<TablePreviewRequest, 'signal'>,
	): Promise<TableSchema>;
	previewRows(
		source: DatabaseSource,
		namespace: string[],
		table: string,
		request: TablePreviewRequest,
	): Promise<TablePreview>;
}

export type DatabaseBrowserRegistry = Partial<Record<DatabaseSource['provider'], DatabaseBrowser>>;
