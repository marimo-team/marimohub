import { z } from 'zod';
import type {
	IntegrationId,
	NotebookId,
	ProjectId,
	SessionId,
	SnapshotId,
	TokenId,
	UserId,
	VersionId,
} from '../ids';
import { SyncTokenRecordSchema } from '../integrations/syncedSource';
import { paths } from '../paths';
import { ProjectAlertConfigSchema } from '../services/notifications/ProjectAlertStore';
import {
	AppClaimSchema,
	CatalogSchema,
	EditorClaimSchema,
	EventSchema,
	FsSnapshotSchema,
	IdentitySchema,
	IntegrationRecordSchema,
	IntegrationVersionRecordSchema,
	NotebookMetaSchema,
	ProjectSchema,
	SessionSchema,
	SnapshotSchema,
	SourceSchema,
	TokenSchema,
	VersionSchema,
} from '../schema';

// Placeholder ids threaded through the real `paths` builders, so the templates
// cannot drift from paths.ts. The brands are compile-time only; the casts are safe.
const PID = '{pid}' as ProjectId;
const NID = '{nid}' as NotebookId;
const VID = '{vid}' as VersionId;
const SID = '{sid}' as SessionId;
const IID = '{iid}' as IntegrationId;
const TID = '{tid}' as TokenId;
const UID = '{uid}' as UserId;
const SNAPSHOT_ID = '{snapshot_id}' as SnapshotId;

// Some path builders encodeURIComponent their segment, which mangles the
// placeholder braces; restore them.
const template = (key: string) => key.replaceAll('%7B', '{').replaceAll('%7D', '}');

type Mutability = 'cas' | 'immutable' | 'last-writer-wins' | 'append-only';

interface BucketObject {
	/** Component name in `components.schemas`. */
	name: string;
	/** Bucket key template (no leading slash). */
	key: string;
	schema: z.ZodType;
	summary: string;
	mutability: Mutability;
	/** The sole writer, for CAS-managed records (see AGENTS.md "Key invariant"). */
	owner?: string;
	secretPaths?: readonly string[];
	tag: string;
}

const project = paths.project(PID);
const notebook = project.notebook(NID);
const projectIntegration = project.integration(IID);
const orgIntegration = paths.orgIntegration(IID);

// `version(n)` zero-pads to 6 digits; widen the padded 0 back into a template.
const integrationVersionTemplate = (key: string) => key.replace('000000', '{n}');

const OBJECTS: BucketObject[] = [
	{
		name: 'Catalog',
		key: paths.catalog,
		schema: CatalogSchema,
		summary: 'The one mutable pointer in the catalog snapshot chain.',
		mutability: 'cas',
		owner: 'CatalogService.mutateSnapshot',
		tag: 'catalog',
	},
	{
		name: 'Snapshot',
		key: paths.snapshot(SNAPSHOT_ID),
		schema: SnapshotSchema,
		summary: 'Immutable full-catalog snapshot addressed by the catalog pointer.',
		mutability: 'immutable',
		tag: 'catalog',
	},
	{
		name: 'Project',
		key: project.meta,
		schema: ProjectSchema,
		summary: 'Project record: members, federation opt-in, status.',
		mutability: 'last-writer-wins',
		tag: 'project',
	},
	{
		name: 'ProjectAlertConfig',
		key: project.alerts,
		schema: ProjectAlertConfigSchema,
		summary: 'Project-scoped Slack and signed-webhook alert destinations.',
		mutability: 'cas',
		owner: 'ProjectAlertStore',
		secretPaths: [
			'destinations.*.webhook_url',
			'destinations.*.url',
			'destinations.*.signing_secret',
		],
		tag: 'project',
	},
	{
		name: 'NotebookMeta',
		key: notebook.meta,
		schema: NotebookMetaSchema,
		summary: 'Notebook metadata record.',
		mutability: 'last-writer-wins',
		tag: 'notebook',
	},
	{
		name: 'Source',
		key: notebook.source,
		schema: SourceSchema,
		summary: 'Notebook source descriptor: local head pointer or git-sync state.',
		mutability: 'last-writer-wins',
		tag: 'notebook',
	},
	{
		name: 'Version',
		key: notebook.version(VID).meta,
		schema: VersionSchema,
		summary: 'Immutable saved-version record beside the version folder.',
		mutability: 'immutable',
		tag: 'notebook',
	},
	{
		name: 'FsSnapshot',
		key: notebook.fsSnapshot,
		schema: FsSnapshotSchema,
		summary: 'Pointer to the notebook’s current provider-native filesystem snapshot.',
		mutability: 'last-writer-wins',
		tag: 'notebook',
	},
	{
		name: 'SyncTokenRecord',
		key: notebook.integrationSyncToken,
		schema: SyncTokenRecordSchema,
		summary: 'Hashed push-sync token for a git-synced notebook.',
		mutability: 'last-writer-wins',
		tag: 'notebook',
	},
	{
		name: 'IntegrationRecord',
		key: projectIntegration.head,
		schema: IntegrationRecordSchema,
		summary: 'Project integration head: kind, name, enabled, current_version pointer.',
		mutability: 'cas',
		owner: 'ProjectIntegrationsStore',
		tag: 'integration',
	},
	{
		name: 'IntegrationVersionRecord',
		key: integrationVersionTemplate(projectIntegration.version(0)),
		schema: IntegrationVersionRecordSchema,
		summary:
			'Immutable integration config revision (secret fields stored as managed envelopes or external references).',
		mutability: 'immutable',
		tag: 'integration',
	},
	{
		name: 'IntegrationRecord',
		key: orgIntegration.head,
		schema: IntegrationRecordSchema,
		summary: 'Org integration head, inherited by every project.',
		mutability: 'cas',
		owner: 'OrgIntegrationsStore',
		tag: 'integration',
	},
	{
		name: 'IntegrationVersionRecord',
		key: integrationVersionTemplate(orgIntegration.version(0)),
		schema: IntegrationVersionRecordSchema,
		summary: 'Immutable org integration config revision.',
		mutability: 'immutable',
		tag: 'integration',
	},
	{
		name: 'Session',
		key: paths.session(PID, SID),
		schema: SessionSchema,
		summary: 'Session lifecycle record, partitioned by project.',
		mutability: 'cas',
		owner: 'SessionService',
		tag: 'session',
	},
	{
		name: 'AppClaim',
		key: paths.appClaim(PID, NID),
		schema: AppClaimSchema,
		summary: 'Per-notebook app-sandbox singleton claim.',
		mutability: 'cas',
		owner: 'SessionService.claimApp/releaseApp',
		tag: 'session',
	},
	{
		name: 'EditorClaim',
		key: paths.editorClaim(PID, NID),
		schema: EditorClaimSchema,
		summary: 'Per-notebook editor claim, including takeover transfer state.',
		mutability: 'cas',
		owner: 'SessionService',
		tag: 'session',
	},
	{
		name: 'Identity',
		key: template(paths.identity(UID)),
		schema: IdentitySchema,
		summary: 'User directory record mapping the auth sub to its display identity.',
		mutability: 'cas',
		owner: 'IdentityService',
		tag: 'auth',
	},
	{
		name: 'Token',
		key: paths.token(TID),
		schema: TokenSchema,
		summary: 'Personal access token record (hash only; the secret never lands here).',
		mutability: 'last-writer-wins',
		tag: 'auth',
	},
	{
		name: 'Event',
		key: paths.event('{date}', '{id}'),
		schema: EventSchema,
		summary: 'Append-only audit event.',
		mutability: 'append-only',
		tag: 'ops',
	},
];

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
	// `io: 'input'` — the stored bytes are what parse must accept, so defaulted
	// fields stay optional and transforms describe their pre-parse shape.
	const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<
		string,
		unknown
	>;
	return rest;
}

const pathParams = (key: string) =>
	[...key.matchAll(/\{([a-z_]+)\}/g)].map(([, name]) => ({
		name,
		in: 'path',
		required: true,
		schema: { type: 'string' },
	}));

/**
 * OpenAPI 3.1 description of every JSON object persisted in the bucket, built
 * from the same zod schemas the services parse with. Each object is modeled as
 * a path with a GET (the shape every reader must accept — removing or narrowing
 * a field is breaking) and a PUT (the shape writers produce — a new required
 * field invalidates already-stored objects, so it is breaking too). CI diffs
 * the committed rendering against main with oasdiff.
 */
export function buildBucketSpec(): Record<string, unknown> {
	const specPaths: Record<string, unknown> = {};
	const schemas: Record<string, unknown> = {};

	for (const obj of OBJECTS) {
		schemas[obj.name] ??= jsonSchema(obj.schema);
		const ref = { $ref: `#/components/schemas/${obj.name}` };
		const opSuffix = obj.key
			.replaceAll(/\{[a-z_]+\}/g, '')
			.replaceAll(/[^a-zA-Z0-9]+/g, '_')
			.replaceAll(/^_+|_+$/g, '');
		specPaths[`/${obj.key}`] = {
			summary: obj.summary,
			parameters: pathParams(obj.key),
			'x-mutability': obj.mutability,
			...(obj.owner ? { 'x-owner': obj.owner } : {}),
			...(obj.secretPaths ? { 'x-secret-paths': obj.secretPaths } : {}),
			get: {
				operationId: `read_${opSuffix}`,
				summary: `Read ${obj.name}`,
				tags: [obj.tag],
				responses: {
					'200': {
						description: 'The stored object.',
						content: { 'application/json': { schema: ref } },
					},
				},
			},
			put: {
				operationId: `write_${opSuffix}`,
				summary: `Write ${obj.name}`,
				tags: [obj.tag],
				requestBody: {
					required: true,
					content: { 'application/json': { schema: ref } },
				},
				responses: { '204': { description: 'Stored.' } },
			},
		};
	}

	return {
		openapi: '3.1.0',
		info: {
			title: 'marimohub bucket objects',
			version: '1.0.0',
			description: [
				'Machine-checkable description of every JSON object marimohub persists in',
				'its storage bucket, generated from the zod schemas in',
				'`packages/core/src/schema.ts` and the key templates in',
				'`packages/core/src/paths.ts`. This is not an HTTP API: paths are bucket',
				'key templates, GET models what readers must accept, PUT models what',
				'writers produce. `x-mutability`/`x-owner` mirror the write-ownership',
				'invariants in AGENTS.md and development_docs/bucket_spec.md.',
				'',
				'Deliberately excluded (no zod schema; internal operational records or',
				'non-JSON artifacts): idempotency records, integration name claims,',
				'reconcile orphan markers, advisory locks, and version/workspace file',
				'artifacts (notebook.py, pyproject.toml, notebook.html, session.json,',
				'README.md, workspace files).',
			].join('\n'),
		},
		tags: [
			{ name: 'catalog', description: 'Catalog pointer and snapshots (`_system/`)' },
			{ name: 'project', description: 'Per-project records (`projects/{pid}/`)' },
			{ name: 'notebook', description: 'Per-notebook records' },
			{ name: 'integration', description: 'Project- and org-scoped integration records' },
			{ name: 'session', description: 'Session records and sandbox claims' },
			{ name: 'auth', description: 'Identities and personal access tokens' },
			{ name: 'ops', description: 'Operational records' },
		],
		paths: specPaths,
		components: { schemas },
	};
}
