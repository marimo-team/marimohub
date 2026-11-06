import {
	LazyMap,
	NotFoundError,
	ResourceExhaustedError,
	ValidationError,
	createSessionId,
	createSlidingWindowBudget,
	exchangeFederatedStorageEnv,
} from '@marimo-hub/core';
import type {
	AuthUser,
	Project,
	ProjectId,
	IntegrationId,
	ProjectIntegrationsService,
	SlidingWindowBudget,
	ObjectIdentity,
	ObjectListRequest,
	ObjectPageRequest,
} from '@marimo-hub/core';
import { z } from '@hono/zod-openapi';
import type { ApiDeps } from '../context';
import { assertProjectRole, authorizationService } from '../shared';
import { federationFor } from '../federation';
import { appendAudit } from '../log';
import { makeObjectBrowseContext, runObjectBrowse } from './objectBrowseContext';

// Input values shared by the REST routes (which add OpenAPI param metadata) and
// the MCP tools (which add descriptions). Limits must match across surfaces:
// `limit` is part of the browse cache key, so a drift stops REST and MCP sharing hits.
export const CATALOG_PAGE_LIMIT = { default: 100, max: 500 } as const;
export const OBJECT_PAGE_LIMIT = { default: 50, max: 100 } as const;
export const PreviewRowLimit = z.number().int().positive().max(100).default(20);

/**
 * Multi-part namespaces ride in one query param, parts joined by U+001F — the
 * Iceberg REST unit separator, which cannot appear in an identifier — so parts
 * containing dots round-trip.
 */
export const NAMESPACE_JOINER = '\u001f';
const NamespacePart = z
	.string()
	.min(1)
	.refine((part) => !part.includes(NAMESPACE_JOINER), {
		message: 'Namespace parts must not contain U+001F.',
	});
export const NamespaceParts = z.array(NamespacePart).min(1);
export const NamespaceValue = z
	.string()
	.min(1)
	// A leading/trailing/doubled joiner splits into empty identifier parts,
	// which no catalog can hold — refuse here (422) instead of spending a probe
	// call on a guaranteed upstream 404.
	.refine((value) => value.split(NAMESPACE_JOINER).every((part) => part !== ''), {
		message: 'Namespace parts must be non-empty.',
	});

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
export const ObjectBucketValue = z.string().min(1).max(255);
export const ObjectPrefixValue = z.string().refine((value) => utf8ByteLength(value) <= 1024, {
	message: "Prefix exceeds S3's 1,024-byte UTF-8 limit.",
});
export const ObjectKeyValue = z
	.string()
	.min(1)
	.refine((value) => utf8ByteLength(value) <= 1024, {
		message: "Key exceeds S3's 1,024-byte UTF-8 limit.",
	});
export const ObjectVersionIdValue = z.string().min(1).max(2048);

export function requireIntegrations(deps: ApiDeps): ProjectIntegrationsService {
	if (!deps.integrations) {
		throw new NotFoundError('Integrations are not enabled on this deployment');
	}
	return deps.integrations;
}

export function requireDataBrowser(deps: ApiDeps): {
	integrations: ProjectIntegrationsService;
	preview: boolean;
} {
	if (!deps.dataBrowser) {
		throw new NotFoundError('The data browser is not enabled on this deployment');
	}
	return {
		integrations: requireIntegrations(deps),
		preview: deps.dataBrowser.preview,
	};
}

const BROWSE_LIST_TTL_MS = 60_000;
const BROWSE_SCHEMA_TTL_MS = 300_000;
const BROWSE_CACHE_MAX_ENTRIES = 1024;

/**
 * A cache entry must not outlive the integration state it was computed from,
 * so every metadata request re-runs resolution (project-then-org, shadowing),
 * the enablement check, and the instance verdict BEFORE the cache is
 * consulted: a shadowed org head 404s and a disabled instance 422s even while
 * a hit is warm. The returned token keys the entry on the config version AND
 * `updated_at` — a rename bumps only the head, yet changes the snippet a
 * schema response embeds. Only the upstream catalog traffic is cached.
 */
async function assertBrowsable(
	integrations: ProjectIntegrationsService,
	pid: ProjectId,
	iid: IntegrationId,
	options: { preview?: boolean } = {},
): Promise<string> {
	const capability = await integrations.browseCapability(pid, iid);
	if (!capability.metadata) {
		throw new ValidationError(capability.reason ?? 'This integration cannot be browsed.');
	}
	if (options.preview && !capability.hub_preview) {
		throw new ValidationError('This integration does not support row preview on this deployment.');
	}
	return `${capability.current_version}:${capability.updated_at}`;
}

export async function resolveObjectAccess(
	deps: ApiDeps,
	project: Project,
	user: AuthUser,
	integrations: ProjectIntegrationsService,
	pid: ProjectId,
	iid: IntegrationId,
	signal?: AbortSignal,
) {
	const filterWrite = async (
		capability: Awaited<ReturnType<ProjectIntegrationsService['browseCapability']>>,
	) => {
		if (capability.surfaces.objects?.write) {
			const decision = await authorizationService(deps).authorize(user, 'integration.write', {
				kind: 'project',
				project,
			});
			capability.surfaces.objects = { ...capability.surfaces.objects, write: decision.allowed };
		}
		return capability;
	};

	const wifEligible = federationFor(project, deps.wif) !== undefined;
	const base = await makeObjectBrowseContext(deps, project, user, signal, {
		integrationId: iid,
		includeFederated: false,
		allowServerAmbient: deps.dataBrowser?.objectBrowser?.allowServerAmbientCredentials,
		disableS3Ambient: wifEligible,
	});
	const baseCapability = await runObjectBrowse(() => integrations.browseCapability(pid, iid, base));
	const objects = baseCapability.surfaces.objects;
	if (objects?.available || !wifEligible || objects?.provider !== 's3') {
		return { context: base, capability: await filterWrite(baseCapability) };
	}
	const federated = await makeObjectBrowseContext(deps, project, user, signal, {
		integrationId: iid,
	});
	return {
		context: federated,
		capability: await filterWrite(
			await runObjectBrowse(() => integrations.browseCapability(pid, iid, federated)),
		),
	};
}

export function requireObjectCapability(
	capability: Awaited<ReturnType<ProjectIntegrationsService['browseCapability']>>,
) {
	const objects = capability.surfaces.objects;
	if (!objects?.available) {
		throw new ValidationError(objects?.reason ?? 'This integration cannot browse objects.');
	}
	return {
		stateToken: `${capability.current_version}:${capability.updated_at}`,
		capability: objects,
	};
}

export async function resolveAuthorizedObjectAccess(
	deps: ApiDeps,
	user: AuthUser,
	integrations: ProjectIntegrationsService,
	pid: ProjectId,
	iid: IntegrationId,
	signal?: AbortSignal,
) {
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'integration.use',
		deps,
	);
	return resolveObjectAccess(deps, project, user, integrations, pid, iid, signal);
}

export async function requireAuthorizedObjectAccess(
	deps: ApiDeps,
	user: AuthUser,
	integrations: ProjectIntegrationsService,
	pid: ProjectId,
	iid: IntegrationId,
	signal?: AbortSignal,
) {
	const access = await resolveAuthorizedObjectAccess(deps, user, integrations, pid, iid, signal);
	return { context: access.context, ...requireObjectCapability(access.capability) };
}

/**
 * Per-replica TTL cache over successful browse results, so tree navigation
 * does not re-spend probe budget on every expansion. The LRU bound and
 * superseded-pending semantics live in core's LazyMap.
 */
type BrowseCache = LazyMap<string, { expiresAt: number; value: unknown }>;

function createBrowseCache(): BrowseCache {
	return new LazyMap(
		async () => {
			throw new Error('A browse cache load function is required.');
		},
		{ maxSize: BROWSE_CACHE_MAX_ENTRIES },
	);
}

async function cachedBrowse<T>(
	cache: BrowseCache,
	key: string,
	ttlMs: number,
	fresh: boolean,
	charge: () => void,
	load: () => Promise<T>,
	observation?: { metrics: ApiDeps['metrics']; operation: string },
): Promise<T> {
	const record = (outcome: 'hit' | 'miss' | 'coalesced' | 'refresh') =>
		observation?.metrics?.increment('object_browser.cache.requests', 1, {
			operation: observation.operation,
			outcome,
		});
	const now = Date.now();
	const hit = fresh ? undefined : cache.getIfPresent(key);
	if (hit && hit.expiresAt > now) {
		record('hit');
		return hit.value as T;
	}
	if (hit) cache.delete(key);
	// Every consumer of a miss pays its own budget BEFORE creating or joining
	// the shared load: an exhausted user 429s alone (never poisoning the shared
	// promise for others), and piggybacking on someone else's load is not free.
	charge();
	const coalesced = !fresh && cache.hasPending(key);
	record(coalesced ? 'coalesced' : fresh ? 'refresh' : 'miss');
	const loaded = await cache.getOrLoad(
		key,
		async () => ({ expiresAt: Date.now() + ttlMs, value: await load() }),
		{ force: fresh },
	);
	return loaded.value as T;
}

interface BrowseCacheOptions {
	operation: string;
	key: unknown[];
	ttlMs: number;
	fresh?: boolean;
}

function browseEndpoint<T>(
	options: BrowseCacheOptions & {
		deps: ApiDeps;
		pid: ProjectId;
		iid: IntegrationId;
		user: AuthUser;
		stateToken: string;
		load: () => Promise<T>;
		observation?: { metrics: ApiDeps['metrics']; operation: string };
	},
): Promise<T> {
	const state = integrationBrowseState(options.deps);
	return cachedBrowse(
		state.cache,
		JSON.stringify([
			options.pid,
			options.iid,
			options.user.id,
			options.user.email,
			options.stateToken,
			options.operation,
			...options.key,
		]),
		options.ttlMs,
		options.fresh ?? false,
		() => assertIntegrationBudget(options.deps, 'browse', options.user.id),
		options.load,
		options.observation,
	);
}

const BUDGET_WINDOW_MS = 60_000;
const integrationBudgetDefinitions = {
	browse: { limit: 20, message: 'Too many browse requests — try again in a minute.' },
	objectSearch: { limit: 5, message: 'Too many object searches — try again in a minute.' },
	objectPreview: { limit: 10, message: 'Too many object previews — try again in a minute.' },
	dataQuery: { limit: 5, message: 'Too many data queries — try again in a minute.' },
	aiQuery: { limit: 5, message: 'Too many AI query requests — try again in a minute.' },
	querySchemaWork: { limit: 512, message: 'Too much query-schema work — try again in a minute.' },
} as const;
type IntegrationBudgetName = keyof typeof integrationBudgetDefinitions;

function createIntegrationBudgets(): Record<IntegrationBudgetName, SlidingWindowBudget<string>> {
	return Object.fromEntries(
		Object.entries(integrationBudgetDefinitions).map(([name, definition]) => [
			name,
			createSlidingWindowBudget<string>({
				limit: definition.limit,
				windowMs: BUDGET_WINDOW_MS,
			}),
		]),
	) as Record<IntegrationBudgetName, SlidingWindowBudget<string>>;
}

interface IntegrationBrowseState {
	cache: BrowseCache;
	budgets: Record<IntegrationBudgetName, SlidingWindowBudget<string>>;
}

function createIntegrationBrowseState(): IntegrationBrowseState {
	return { cache: createBrowseCache(), budgets: createIntegrationBudgets() };
}

let integrationBrowseStates = new WeakMap<ApiDeps, IntegrationBrowseState>();

function integrationBrowseState(deps: ApiDeps): IntegrationBrowseState {
	let state = integrationBrowseStates.get(deps);
	if (!state) {
		state = createIntegrationBrowseState();
		integrationBrowseStates.set(deps, state);
	}
	return state;
}

export function assertIntegrationBudget(
	deps: ApiDeps,
	name: IntegrationBudgetName,
	userId: string,
): void {
	if (!consumeIntegrationBudget(deps, name, userId)) {
		throw new ResourceExhaustedError(integrationBudgetDefinitions[name].message);
	}
}

export function consumeIntegrationBudget(
	deps: ApiDeps,
	name: IntegrationBudgetName,
	userId: string,
): boolean {
	return integrationBrowseState(deps).budgets[name].consume(userId);
}

export function clearBrowseStateForTests(): void {
	integrationBrowseStates = new WeakMap();
}

export interface IntegrationBrowseContext {
	deps: ApiDeps;
	user: AuthUser;
	pid: ProjectId;
	iid: IntegrationId;
	signal?: AbortSignal;
	request: { requestId?: string; method: string; path: string };
}
interface BrowsePage {
	limit: number;
	cursor?: string;
	fresh?: boolean;
}
const OBJECT_METADATA_TTL_MS = 15_000;

async function browseCatalogMetadata<T>(
	context: IntegrationBrowseContext,
	options: BrowseCacheOptions & { load: (integrations: ProjectIntegrationsService) => Promise<T> },
) {
	const { deps, user, pid, iid } = context;
	const { integrations } = requireDataBrowser(deps);
	await assertProjectRole(deps.services.projects, pid, user, 'integration.use', deps);
	const stateToken = await assertBrowsable(integrations, pid, iid);
	// Coalesced catalog loads must survive cancellation of an individual caller.
	return browseEndpoint({
		...context,
		...options,
		stateToken,
		load: () => options.load(integrations),
	});
}

async function authorizedObjectBrowse({ deps, user, pid, iid, signal }: IntegrationBrowseContext) {
	const { integrations } = requireDataBrowser(deps);
	const access = await requireAuthorizedObjectAccess(deps, user, integrations, pid, iid, signal);
	return { integrations, ...access };
}

export async function listIntegrationNamespaces(
	context: IntegrationBrowseContext,
	input: BrowsePage & { parent?: string[] },
) {
	const { user, pid, iid } = context;
	const { limit, cursor, parent, fresh } = input;
	const browseRequest = {
		limit,
		query_user: user.email,
		...(cursor !== undefined ? { cursor } : {}),
		...(parent !== undefined ? { parent } : {}),
	};
	return browseCatalogMetadata(context, {
		operation: 'namespaces',
		key: [limit, cursor, parent],
		ttlMs: BROWSE_LIST_TTL_MS,
		fresh,
		load: (integrations) => integrations.browseNamespaces(pid, iid, browseRequest),
	});
}

export async function listIntegrationTables(
	context: IntegrationBrowseContext,
	input: BrowsePage & { namespace: string[] },
) {
	const { user, pid, iid } = context;
	const { limit, cursor, namespace, fresh } = input;
	const browseRequest = {
		limit,
		query_user: user.email,
		...(cursor !== undefined ? { cursor } : {}),
	};
	return browseCatalogMetadata(context, {
		operation: 'tables',
		key: [namespace, limit, cursor],
		ttlMs: BROWSE_LIST_TTL_MS,
		fresh,
		load: (integrations) => integrations.browseTables(pid, iid, namespace, browseRequest),
	});
}

export async function getIntegrationTableSchema(
	context: IntegrationBrowseContext,
	input: { namespace: string[]; table: string; fresh?: boolean },
) {
	const { user, pid, iid } = context;
	const { namespace, table, fresh } = input;
	return browseCatalogMetadata(context, {
		operation: 'schema',
		key: [namespace, table],
		ttlMs: BROWSE_SCHEMA_TTL_MS,
		fresh,
		load: (integrations) =>
			integrations.browseTableSchema(pid, iid, namespace, table, {
				query_user: user.email,
			}),
	});
}

export async function previewIntegrationTable(
	{ deps, user, pid, iid, signal, request }: IntegrationBrowseContext,
	input: { namespace: string[]; table: string; limit: number },
) {
	const { namespace, table, limit } = input;
	const { integrations, preview } = requireDataBrowser(deps);
	const project = await assertProjectRole(
		deps.services.projects,
		pid,
		user,
		'integration.use',
		deps,
	);
	const wif = federationFor(project, deps.wif);
	if (!preview) throw new NotFoundError('Row preview is not enabled on this deployment');
	await assertBrowsable(integrations, pid, iid, { preview: true });
	assertIntegrationBudget(deps, 'browse', user.id);
	const sessionId = createSessionId();
	const data = await integrations.browseTablePreview(
		pid,
		iid,
		{ userId: user.id, email: user.email },
		sessionId,
		namespace,
		table,
		{ limit, query_user: user.email, signal },
		wif
			? () =>
					exchangeFederatedStorageEnv(wif.issuer, wif.issuerUrl, wif.target, pid, {
						kind: 'session',
						id: sessionId,
					})
			: undefined,
	);
	await appendAudit({ ...request, userId: user.id }, 'integration.preview', () =>
		deps.services.events.append({
			event: 'integration.preview',
			actor: user.id,
			project_id: pid,
			integration_id: iid,
			namespace,
			table,
			row_limit: limit,
		}),
	);
	return data;
}

export async function listIntegrationObjectBuckets(
	browse: IntegrationBrowseContext,
	input: ObjectPageRequest & { fresh?: boolean },
) {
	const { deps, pid, iid } = browse;
	const { limit, cursor, fresh } = input;
	const { integrations, context, stateToken } = await authorizedObjectBrowse(browse);
	const browseRequest = { limit, ...(cursor ? { cursor } : {}) };
	return browseEndpoint({
		...browse,
		stateToken,
		operation: 'object-buckets',
		key: [browseRequest],
		ttlMs: OBJECT_METADATA_TTL_MS,
		fresh,
		load: () =>
			runObjectBrowse(() => integrations.browseObjectBuckets(pid, iid, context, browseRequest)),
		observation: { metrics: deps.metrics, operation: 'list_buckets' },
	});
}

export async function listIntegrationObjects(
	browse: IntegrationBrowseContext,
	input: ObjectListRequest & { fresh?: boolean },
) {
	const { deps, pid, iid } = browse;
	const { bucket, prefix, limit, cursor, fresh } = input;
	const { integrations, context, stateToken } = await authorizedObjectBrowse(browse);
	const browseRequest = {
		bucket,
		limit,
		...(prefix !== undefined ? { prefix } : {}),
		...(cursor ? { cursor } : {}),
	};
	return browseEndpoint({
		...browse,
		stateToken,
		operation: 'objects',
		key: [browseRequest],
		ttlMs: OBJECT_METADATA_TTL_MS,
		fresh,
		load: () => runObjectBrowse(() => integrations.browseObjects(pid, iid, context, browseRequest)),
		observation: { metrics: deps.metrics, operation: 'list_objects' },
	});
}

export async function getIntegrationObjectMetadata(
	browse: IntegrationBrowseContext,
	input: ObjectIdentity,
) {
	const { deps, user, pid, iid } = browse;
	const { bucket, key, version_id } = input;
	const { integrations, context } = await authorizedObjectBrowse(browse);
	const browseRequest = { bucket, key, ...(version_id ? { version_id } : {}) };
	assertIntegrationBudget(deps, 'browse', user.id);
	return runObjectBrowse(() => integrations.browseObjectDetail(pid, iid, context, browseRequest));
}

export async function previewIntegrationObject(
	browse: IntegrationBrowseContext,
	input: ObjectIdentity & { limit: number },
) {
	const { deps, user, pid, iid, request } = browse;
	const body = input;
	const { integrations, capability, context } = await authorizedObjectBrowse(browse);
	if (!capability.preview) throw new NotFoundError('Object preview is not enabled.');
	assertIntegrationBudget(deps, 'objectPreview', user.id);
	const contentParams = new URLSearchParams({ bucket: body.bucket, key: body.key, inline: 'true' });
	if (body.version_id) contentParams.set('version_id', body.version_id);
	const data = await runObjectBrowse(() =>
		integrations.browseObjectPreview(pid, iid, context, {
			...body,
			content_url: `/api/v1/projects/${pid}/integrations/${iid}/browse/objects/content?${contentParams}`,
		}),
	);
	if (data.kind !== 'image') {
		await appendAudit({ ...request, userId: user.id }, 'integration.object.preview', () =>
			deps.services.events.append({
				event: 'integration.object.preview',
				actor: user.id,
				project_id: pid,
				integration_id: iid,
				bucket: body.bucket,
				key: body.key,
				...(body.version_id ? { version_id: body.version_id } : {}),
				format: data.kind === 'unsupported' ? data.detected_type : data.format,
				bytes: 'bytes_read' in data ? data.bytes_read : undefined,
				request_id: request.requestId,
			}),
		);
	}
	return data;
}
