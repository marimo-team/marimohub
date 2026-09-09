import { z } from 'zod';
import {
	ResourceExhaustedError,
	UnavailableError,
	ValidationError,
	withDeadline,
} from '@marimo-hub/core';
import type {
	BigQueryConnectionCapability,
	BrowseNamespacesRequest,
	BrowsePageRequest,
	DatabaseBrowser,
	DatabaseSource,
	DatabaseTestOptions,
	IntegrationProbe,
	TablePreviewRequest,
	TestResult,
} from '@marimo-hub/core';
import { BigQueryTokenCache } from './auth';
import { dataSchema, decodeRow, parseResponse, tableColumns, tableSchema } from './schema';

const datasetPage = z.object({
	datasets: z.array(z.object({ datasetReference: z.object({ datasetId: z.string() }) })).optional(),
	nextPageToken: z.string().optional(),
});
const tablePage = z.object({
	tables: z.array(z.object({ tableReference: z.object({ tableId: z.string() }) })).optional(),
	nextPageToken: z.string().optional(),
});
type Get = (path: string, params?: Record<string, string>) => Promise<unknown>;

export interface BigQueryBrowserOptions {
	probe: IntegrationProbe;
	testProbe?: IntegrationProbe;
	mode: 'metadata' | 'full';
	metadataTimeoutMs?: number;
	previewTimeoutMs?: number;
	previewMaxBytes?: number;
}

export class BigQueryDatabaseBrowser implements DatabaseBrowser {
	readonly provider = 'bigquery' as const;
	readonly preview: boolean;
	private readonly tokens = new BigQueryTokenCache();

	constructor(private readonly options: BigQueryBrowserOptions) {
		this.preview = options.mode === 'full';
	}

	async testConnection(
		source: DatabaseSource,
		options: DatabaseTestOptions = {},
	): Promise<TestResult> {
		const started = performance.now();
		try {
			await this.run(source, 'test', options.signal, async (get, connection) => {
				if (connection.dataset) {
					parseResponse(
						z.object({ datasetReference: z.object({ datasetId: z.string() }) }),
						await get(`datasets/${segment(connection.dataset)}`),
					);
				} else {
					parseResponse(datasetPage, await get('datasets', { maxResults: '1' }));
				}
			});
			return {
				ok: true,
				latency_ms: Math.round(performance.now() - started),
				details: 'BigQuery metadata access verified. Row access was not tested.',
			};
		} catch (error) {
			return {
				ok: false,
				latency_ms: Math.round(performance.now() - started),
				details:
					error instanceof ValidationError || error instanceof UnavailableError
						? error.message
						: 'BigQuery metadata access could not be verified.',
			};
		}
	}

	async listNamespaces(source: DatabaseSource, request: BrowseNamespacesRequest) {
		assertSource(source);
		if (request.parent?.length) return { items: [], next_cursor: null };
		return this.run(source, 'metadata', request.signal, async (get) => {
			const page = parseResponse(datasetPage, await get('datasets', pageParams(request)));
			const items = (page.datasets ?? []).map((item) => [item.datasetReference.datasetId]);
			return { items, next_cursor: nextCursor(page.nextPageToken, items.length, request) };
		});
	}

	async listTables(source: DatabaseSource, namespace: string[], request: BrowsePageRequest) {
		return this.run(source, 'metadata', request.signal, async (get) => {
			const page = parseResponse(
				tablePage,
				await get(`${datasetPath(namespace)}/tables`, pageParams(request)),
			);
			const items = (page.tables ?? []).map((item) => item.tableReference.tableId);
			return { items, next_cursor: nextCursor(page.nextPageToken, items.length, request) };
		});
	}

	async getTableSchema(
		source: DatabaseSource,
		namespace: string[],
		table: string,
		request?: Pick<TablePreviewRequest, 'signal'>,
	) {
		return this.run(source, 'metadata', request?.signal, async (get) => {
			const metadata = parseResponse(
				tableSchema,
				await get(`${datasetPath(namespace)}/tables/${segment(table)}`),
			);
			const partition = metadata.rangePartitioning?.field ?? metadata.timePartitioning?.field;
			return {
				columns: tableColumns(metadata.schema.fields),
				...(partition
					? { partitioning: [partition] }
					: metadata.timePartitioning
						? { partitioning: ['_PARTITIONTIME'] }
						: {}),
			};
		});
	}

	async previewRows(
		source: DatabaseSource,
		namespace: string[],
		table: string,
		request: TablePreviewRequest,
	) {
		if (!this.preview) throw new ValidationError('Row preview requires full data-browser mode.');
		if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1000)
			throw new ValidationError('Invalid preview row limit.');
		return this.run(source, 'preview', request.signal, async (get) => {
			const path = `${datasetPath(namespace)}/tables/${segment(table)}`;
			const response = await get(path);
			if (parseResponse(z.object({ type: z.string() }), response).type !== 'TABLE')
				throw new ValidationError(
					'Hub previews support BigQuery base tables. Open this view or external table in a notebook to query it.',
				);
			const metadata = parseResponse(tableSchema, response);
			const data = parseResponse(
				dataSchema,
				await get(`${path}/data`, { maxResults: String(request.limit) }),
			);
			const result = {
				columns: metadata.schema.fields.map((field) => field.name),
				rows: (data.rows ?? [])
					.slice(0, request.limit)
					.map((row) => decodeRow(metadata.schema.fields, row)),
			};
			if (
				new TextEncoder().encode(JSON.stringify(result)).byteLength >
				(this.options.previewMaxBytes ?? 1024 * 1024)
			) {
				throw new UnavailableError(
					'The BigQuery sample exceeds the preview byte limit. Select fewer rows or open it in a notebook.',
				);
			}
			return result;
		});
	}

	private async run<T>(
		source: DatabaseSource,
		operation: 'metadata' | 'preview' | 'test',
		signal: AbortSignal | undefined,
		run: (get: Get, source: BigQueryConnectionCapability) => Promise<T>,
	): Promise<T> {
		assertSource(source);
		const probe =
			operation === 'test' ? (this.options.testProbe ?? this.options.probe) : this.options.probe;
		try {
			return await withDeadline(
				async (bounded) => {
					const token = await this.tokens.get(source.credentials_json, probe, bounded);
					return run(async (path, params) => {
						bounded.throwIfAborted();
						const url = new URL(
							`https://bigquery.googleapis.com/bigquery/v2/projects/${segment(source.project_id)}/${path}`,
						);
						url.search = new URLSearchParams(params).toString();
						const response = await probe.fetch(url.toString(), {
							headers: { Authorization: `Bearer ${token}` },
							signal: bounded,
						});
						if (response.status === 401)
							await this.tokens.invalidate(source.credentials_json, token);
						if (!response.ok)
							throw new UnavailableError(
								response.status === 401 || response.status === 403
									? 'BigQuery access was denied. Check the service-account permissions for this resource.'
									: response.status === 404
										? 'The BigQuery resource was not found.'
										: 'BigQuery is unavailable.',
							);
						return response.json();
					}, source);
				},
				{
					signal,
					timeoutMs:
						operation === 'test'
							? 10_000
							: operation === 'preview'
								? (this.options.previewTimeoutMs ?? 30_000)
								: (this.options.metadataTimeoutMs ?? 30_000),
					timeoutError: () => new UnavailableError('The BigQuery request timed out.'),
					abortError: () => new UnavailableError('The BigQuery request was canceled.'),
				},
			);
		} catch (error) {
			if (
				error instanceof ValidationError ||
				error instanceof UnavailableError ||
				error instanceof ResourceExhaustedError
			)
				throw error;
			throw new UnavailableError('The BigQuery request failed.');
		}
	}
}

function assertSource(source: DatabaseSource): asserts source is BigQueryConnectionCapability {
	if (source.provider !== 'bigquery')
		throw new ValidationError('The database provider does not match BigQuery.');
}

function segment(value: string): string {
	if (!value || value === '.' || value === '..')
		throw new ValidationError('Invalid BigQuery resource name.');
	return encodeURIComponent(value);
}

function datasetPath(namespace: string[]) {
	if (namespace.length !== 1)
		throw new ValidationError('BigQuery tables need one dataset namespace.');
	return `datasets/${segment(namespace[0])}`;
}

function pageParams(request: BrowsePageRequest) {
	if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1000)
		throw new ValidationError('Invalid catalog page limit.');
	return {
		maxResults: String(request.limit),
		...(request.cursor ? { pageToken: request.cursor } : {}),
	};
}

function nextCursor(token: string | undefined, count: number, request: BrowsePageRequest) {
	if (token && token === request.cursor)
		throw new UnavailableError('BigQuery returned a non-advancing page token.');
	if (count > request.limit)
		throw new UnavailableError('BigQuery exceeded the catalog page limit.');
	return token || null;
}
