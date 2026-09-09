import { z } from 'zod';
import { UnavailableError, ValidationError } from '../../../errors';
import { withDeadline } from '../../../async';
import type { BrowsePageRequest, IntegrationProbe, TestResult } from '../../../ports/integrations';
import { basicAuthHeader } from '../sdk';
import type { BrowseCapability } from '../sdk';
import type { DatabricksConfig } from './databricks';

const named = z.object({ name: z.string().min(1) });
const pageSchema = z.object({
	catalogs: z.array(named).optional(),
	schemas: z.array(named).optional(),
	tables: z.array(named).optional(),
	next_page_token: z.string().optional(),
});
const tableSchema = z.object({
	columns: z.array(
		z.object({
			name: z.string(),
			type_text: z.string(),
			nullable: z.boolean(),
			comment: z.string().optional(),
			partition_index: z.number().int().nonnegative().optional(),
		}),
	),
});
const tokenSchema = z.object({
	access_token: z
		.string()
		.min(1)
		.regex(/^[^\r\n]+$/),
});

type MetadataGet = (path: string, params?: Record<string, string>) => Promise<unknown>;

async function withMetadata<T>(
	config: DatabricksConfig,
	probe: IntegrationProbe,
	signal: AbortSignal | undefined,
	run: (get: MetadataGet) => Promise<T>,
	timeoutMs = 30_000,
): Promise<T> {
	return withDeadline(
		async (bounded) => {
			bounded.throwIfAborted();
			let token: string;
			if (config.auth.method === 'personal_access_token') {
				token = config.auth.token;
			} else {
				const response = await probe.fetch(`https://${config.host}/oidc/v1/token`, {
					method: 'POST',
					signal: bounded,
					headers: {
						Authorization: basicAuthHeader(config.auth.client_id, config.auth.client_secret),
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams({
						grant_type: 'client_credentials',
						scope: 'all-apis',
					}).toString(),
				});
				if (!response.ok) throw new UnavailableError('Databricks authentication failed.');
				token = parseResponse(tokenSchema, await response.json()).access_token;
			}
			if (!token || /[\r\n]/.test(token)) throw new ValidationError('Invalid Databricks token.');
			return run(async (path, params) => {
				bounded.throwIfAborted();
				const url = new URL(`https://${config.host}/api/2.1/unity-catalog/${path}`);
				url.search = new URLSearchParams(params).toString();
				const response = await probe.fetch(url.toString(), {
					headers: { Authorization: `Bearer ${token}` },
					signal: bounded,
				});
				if (!response.ok) {
					throw new UnavailableError(
						response.status === 401 || response.status === 403
							? 'Databricks metadata access was denied. Check the integration credentials and catalog permissions.'
							: response.status === 404
								? 'The Databricks catalog resource was not found.'
								: 'Databricks metadata is unavailable.',
					);
				}
				return response.json();
			});
		},
		{
			signal,
			timeoutMs,
			timeoutError: () => new UnavailableError('The Databricks request timed out.'),
			abortError: () => new UnavailableError('The Databricks request was canceled.'),
		},
	);
}

function parseResponse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
	const parsed = schema.safeParse(body);
	if (!parsed.success) throw new UnavailableError('Databricks returned invalid metadata.');
	return parsed.data;
}

async function list(
	get: MetadataGet,
	resource: 'catalogs' | 'schemas' | 'tables',
	request: BrowsePageRequest,
	params: Record<string, string> = {},
) {
	if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 1000) {
		throw new ValidationError('Invalid catalog page limit.');
	}
	const limit = resource === 'tables' ? Math.min(request.limit, 50) : request.limit;
	const page = parseResponse(
		pageSchema,
		await get(resource, {
			...params,
			max_results: String(limit),
			...(request.cursor ? { page_token: request.cursor } : {}),
		}),
	);
	const cursor = page.next_page_token || null;
	if (cursor && cursor === request.cursor)
		throw new UnavailableError('Databricks returned a non-advancing page token.');
	const items = page[resource] ?? [];
	if (items.length > limit)
		throw new UnavailableError('Databricks exceeded the catalog page limit.');
	return { items: items.map((item) => item.name), next_cursor: cursor };
}

export async function testDatabricksMetadata(
	config: DatabricksConfig,
	probe: IntegrationProbe,
	options?: { signal?: AbortSignal },
): Promise<TestResult> {
	const started = performance.now();
	try {
		if (config.schema && !config.catalog) {
			throw new ValidationError('Configure a catalog to verify the default Databricks schema.');
		}
		await withMetadata(
			config,
			probe,
			options?.signal,
			async (get) => {
				if (config.catalog) {
					parseResponse(named, await get(`catalogs/${encodeURIComponent(config.catalog)}`));
					if (config.schema)
						parseResponse(
							named,
							await get(`schemas/${encodeURIComponent(`${config.catalog}.${config.schema}`)}`),
						);
				} else {
					await list(get, 'catalogs', { limit: 1 });
				}
			},
			10_000,
		);
		return {
			ok: true,
			latency_ms: Math.round(performance.now() - started),
			details: 'Databricks metadata access verified. SQL warehouse execution was not tested.',
		};
	} catch (error) {
		return {
			ok: false,
			latency_ms: Math.round(performance.now() - started),
			details:
				error instanceof UnavailableError || error instanceof ValidationError
					? error.message
					: 'Databricks metadata access could not be verified.',
		};
	}
}

export const databricksBrowse: BrowseCapability<DatabricksConfig> = {
	available: () => ({ ok: true }),
	async listNamespaces(config, probe, request) {
		const parent = request.parent ?? [];
		if (parent.length > 1) return { items: [], next_cursor: null };
		return withMetadata(config, probe, request.signal, async (get) => {
			const page = await list(
				get,
				parent.length > 0 ? 'schemas' : 'catalogs',
				request,
				parent.length > 0 ? { catalog_name: parent[0] } : {},
			);
			return { ...page, items: page.items.map((name) => [...parent, name]) };
		});
	},
	async listTables(config, probe, namespace, request) {
		if (namespace.length !== 2) return { items: [], next_cursor: null };
		return withMetadata(config, probe, request.signal, (get) =>
			list(get, 'tables', request, {
				catalog_name: namespace[0],
				schema_name: namespace[1],
				omit_columns: 'true',
				omit_properties: 'true',
			}),
		);
	},
	async getTableSchema(config, probe, namespace, table, request) {
		if (namespace.length !== 2)
			throw new ValidationError('Databricks tables need a catalog and schema.');
		return withMetadata(config, probe, request?.signal, async (get) => {
			const data = parseResponse(
				tableSchema,
				await get(`tables/${encodeURIComponent([...namespace, table].join('.'))}`),
			);
			const partitioning = data.columns
				.filter((column) => column.partition_index !== undefined)
				.sort((a, b) => a.partition_index! - b.partition_index!)
				.map((column) => column.name);
			return {
				columns: data.columns.map((column) => ({
					name: column.name,
					type: column.type_text,
					nullable: column.nullable,
					...(column.comment ? { comment: column.comment } : {}),
				})),
				...(partitioning.length > 0 ? { partitioning } : {}),
			};
		});
	},
	snippet(instanceName, namespace, table) {
		const sql = `SELECT * FROM ${[...namespace, table].map((part) => `\`${part.replaceAll('`', '``')}\``).join('.')} LIMIT 100`;
		return [
			'import json',
			'import os',
			'from pathlib import Path',
			'from databricks import sql',
			'',
			`connection_config = json.loads((Path(os.environ["MARIMOHUB_INTEGRATIONS_DIR"]) / "databricks" / ${JSON.stringify(`${instanceName}.json`)}).read_text())`,
			'connection_options = {"server_hostname": connection_config["host"], "http_path": connection_config["http_path"]}',
			'if connection_config["auth_method"] == "personal_access_token":',
			'    connection_options["access_token"] = os.environ[connection_config["token_env"]]',
			'else:',
			'    from databricks.sdk.core import Config, oauth_service_principal',
			'    oauth_config = Config(host="https://" + connection_config["host"], client_id=connection_config["client_id"], client_secret=os.environ[connection_config["client_secret_env"]])',
			'    connection_options["credentials_provider"] = lambda: oauth_service_principal(oauth_config)',
			'with sql.connect(**connection_options) as connection:',
			'    with connection.cursor() as cursor:',
			`        cursor.execute(${JSON.stringify(sql)})`,
			'        rows = cursor.fetchall()',
			'rows',
		].join('\n');
	},
};
