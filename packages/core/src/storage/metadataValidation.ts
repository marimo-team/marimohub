import { WarmPoolRecordSchema } from '../services/runtime/WarmPoolStore';
import { AppPoolSchema } from '../services/runtime/AppPoolRouter';
import { ThumbnailRecordSchema } from '../services/content/ThumbnailService';
import { WorkspaceManifestSchema } from '../services/content/workspaceManifest';
import { PreviewRecordSchema } from '../services/content/notebookPreviews';
import { proposalSha256 } from '../services/content/proposalUtils';
import {
	DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS,
	DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS,
} from '../services/content/NotebookProposalService';
import { z } from 'zod';
import type { Bucket, BucketObjectBody } from '../ports/bucket';
import { STORED_OBJECTS } from '../specs/bucketSpec';
import { classifyMetadataKey } from './metadataKeys';
import { CursorSchema } from '../services/catalog/retentionCursor';
import { SnapshotExpiryCursorSchema } from '../services/catalog/MaintenanceService';
import { LockRecordSchema } from '../services/catalog/MaintenanceLock';
import { IdempotencyRecordSchema } from '../services/catalog/IdempotencyService';
import { OrphanMarkerSchema } from '../services/runtime/ReconciliationService';
import { SandboxDiagnosticLeaseSchema } from '../services/runtime/SandboxDiagnosticLease';
import { OAuthClientRecordSchema } from '../services/oauth/OAuthClientStore';
import { OAuthRateLimitRecordSchema } from '../services/oauth/OAuthRateLimitService';
import { OAuthAuthorizationSchema } from '../services/oauth/OAuthAuthorizationService';
import {
	CliAuthorizationSchema,
	DeviceUserCodeClaimSchema,
} from '../services/tokens/CliAuthorizationService';
import { headSchema, accountSchema } from '../services/identity/SourceControlAccountService';
import {
	JobRunSchema,
	NotebookProposalSchema,
	CatalogSchema,
	SessionSchema,
	SourceSchema,
	SnapshotSchema,
} from '../schema';
import { paths } from '../paths';
import { utcTimestamp } from '../stringFormats';
import type { ProjectId, NotebookId } from '../ids';

const additional: [RegExp, z.ZodType][] = [
	[
		/^(?:_system|projects\/[^/]+)\/integrations\/_names\//,
		z.object({ integration_id: z.string().nullable(), claimed_at: utcTimestamp() }),
	],
	[/^_system\/(notebook-gc|notebook-purge|project-purge|job-prune)-cursor\.json$/, CursorSchema],
	[/\/prune-(runs|occurrences)\.json$/, CursorSchema],
	[/^_system\/snapshot-expiry-cursor\.json$/, SnapshotExpiryCursorSchema],
	[/^_system\/(?:_\w+\.lock|search\/lock\.json)$/, LockRecordSchema],
	[/^_system\/idempotency\/[^/]+\.json$/, IdempotencyRecordSchema],
	[/^_system\/reconcile\/orphans\/[^/]+\.json$/, OrphanMarkerSchema],
	[/^_system\/sandbox-diagnostics\/[^/]+\.json$/, SandboxDiagnosticLeaseSchema],
	[/^_system\/oauth-clients\/[^/]+\.json$/, OAuthClientRecordSchema],
	[/^_system\/oauth-rate-limits\/[^/]+\.json$/, OAuthRateLimitRecordSchema],
	[/^_system\/oauth-authorizations\/[^/]+\.json$/, OAuthAuthorizationSchema],
	[/^_system\/cli-authorizations\/[^/]+\.json$/, CliAuthorizationSchema],
	[/^_system\/cli-device-user-codes\/[^/]+\.json$/, DeviceUserCodeClaimSchema],
	[/^_system\/source-control-accounts\/[^/]+\/head\.json$/, headSchema],
	[/^_system\/source-control-accounts\/[^/]+\/[^/]+\.json$/, accountSchema],
	[/^_system\/source-control-account-cleanup\.json$/, z.object({ after: z.string().optional() })],
	[/\/thumbnail-attempts\/[^/]+\.json$/, z.object({ started_at: utcTimestamp() })],
	[/^_system\/job-operations\//, z.object({ holder: z.string().nullable() })],
];

const schemas = STORED_OBJECTS.map(({ key, schema }) => ({
	key,
	schema,
	pattern: new RegExp(
		`^${key
			.split(/(\{[^}]+\})/)
			.map((part) =>
				part.startsWith('{') ? '[^/]+' : part.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'),
			)
			.join('')}$`,
	),
})).sort((a, b) => (a.key.match(/\{/g)?.length ?? 0) - (b.key.match(/\{/g)?.length ?? 0));

export async function validateMetadataRecord(record: BucketObjectBody): Promise<void> {
	if (classifyMetadataKey(record.key) !== 'metadata') throw new Error('Expected metadata record');
	const bytes = await record.bytes();
	if (record.key.startsWith('_system/job-deletions/')) {
		if (!utcTimestamp().safeParse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).success)
			throw new Error(`Invalid job deletion marker: ${record.key}`);
		return;
	}
	if (
		/\/(job-index|run-index|deep-links)\/[^/]+\.json$/.test(record.key) &&
		!record.key.startsWith('_system/')
	) {
		if (bytes.length > 0) throw new Error(`Invalid empty index marker: ${record.key}`);
		return;
	}
	const schema =
		additional.find(([pattern]) => pattern.test(record.key))?.[1] ??
		schemas.find(({ pattern }) => pattern.test(record.key))?.schema;
	if (!schema) throw new Error(`No owner validator for metadata key: ${record.key}`);
	try {
		schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
	} catch {
		// Schema errors may contain secrets from the record.
		throw new Error(`Invalid metadata record: ${record.key}`);
	}
}

export async function auditMetadataReferences(bucket: Bucket): Promise<void> {
	const requireKey = async (key: string) => {
		if (!(await bucket.head(key))) throw new Error(`Missing referenced object: ${key}`);
	};
	const catalogObject = await bucket.get(paths.catalog);
	if (catalogObject) {
		const catalog = CatalogSchema.parse(await catalogObject.json());
		if (catalog.current_snapshot_key !== paths.snapshot(catalog.current_snapshot_id))
			throw new Error('Catalog snapshot identity mismatch');
		for (const id of [catalog.current_snapshot_id, catalog.previous_snapshot_id]) {
			if (!id) continue;
			await requireKey(paths.snapshot(id));
		}
		const current = await bucket.get(paths.snapshot(catalog.current_snapshot_id));
		const snapshot = SnapshotSchema.parse(await current!.json());
		for (const project of snapshot.projects) {
			await requireKey(paths.project(project.id).meta);
			for (const notebook of project.notebooks) {
				await requireKey(paths.project(project.id).notebook(notebook.id).meta);
				await requireKey(paths.project(project.id).notebook(notebook.id).source);
			}
		}
	}
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ cursor, limit: 100 });
		for (const item of page.objects) {
			if (classifyMetadataKey(item.key) !== 'metadata') continue;
			const object = await bucket.get(item.key);
			if (!object) throw new Error('Metadata changed during reference audit');
			await validateMetadataRecord(object);
			if (object.size > 0 && !item.key.startsWith('_system/job-deletions/')) {
				const doc = await object.json<Record<string, unknown>>();
				const blocked =
					(item.key.startsWith('_system/notebook-moves/') && doc.phase !== 'complete') ||
					(/\/(?:object-uploads|uploads)\/[^/]+\.json$/.test(item.key) &&
						['uploading', 'publishing'].includes(String(doc.status))) ||
					(/\/imports\/[^/]+\/items\//.test(item.key) &&
						['preparing', 'publishing'].includes(String(doc.state))) ||
					(item.key.startsWith('_system/working-branches/notebooks/') &&
						(item.key.includes('/saves/')
							? !['complete', 'no_changes', 'conflict', 'expired'].includes(String(doc.state))
							: !['ready', 'deleted'].includes(String(doc.state)) || !!doc.active_save)) ||
					(/\/jobs\/[^/]+\/runs\/[^/]+\/run\.json$/.test(item.key) &&
						['queued', 'provisioning', 'running'].includes(String(doc.status)));
				if (blocked)
					throw new Error(`Reconcile pending operation before metadata transfer: ${item.key}`);
			}

			if (item.key.startsWith('_system/warm-pools/')) {
				const pool = WarmPoolRecordSchema.parse(await object.json());
				if (pool.pools.some((entry) => entry.members.length > 0))
					throw new Error('Drain warm pools before metadata transfer');
			}
			if (item.key.startsWith('_system/app-pools/')) {
				const pool = AppPoolSchema.parse(await object.json());
				if (pool.members.length > 0) throw new Error('Drain app pools before metadata transfer');
			}
			if (item.key.startsWith('_system/previews/')) {
				const preview = PreviewRecordSchema.parse(await object.json());
				if (
					preview.lease ||
					preview.revisions.some((revision) => revision.state !== 'ready') ||
					preview.admissions.some((admission) => !admission.committed)
				)
					throw new Error('Reconcile preview preparation before metadata transfer');
				if (preview.current) {
					const runtime = paths.project(preview.project_id).notebook(preview.current.notebook_id);
					await requireKey(runtime.previewMeta);
					await requireKey(runtime.version(preview.current.version_id).code);
				}
			}
			if (item.key.endsWith('/workspace-manifest.json')) {
				const manifest = WorkspaceManifestSchema.parse(await object.json());
				for (const file of manifest) {
					const key = `${item.key.slice(0, -'workspace-manifest.json'.length)}workspace/${file.path}`;
					const artifact = await bucket.get(key);
					if (
						!artifact ||
						artifact.size !== file.size_bytes ||
						(await proposalSha256(await artifact.bytes())) !== file.sha256
					)
						throw new Error(`Invalid referenced workspace artifact: ${key}`);
				}
			}
			if (item.key.endsWith('/thumbnail.json')) {
				const thumbnail = ThumbnailRecordSchema.parse(await object.json());
				for (const image of [thumbnail.custom, thumbnail.automatic])
					if (image)
						await requireKey(
							`${item.key.slice(0, -'thumbnail.json'.length)}thumbnails/${image.id}.png`,
						);
			}
			if (/\/jobs\/[^/]+\/runs\/[^/]+\/run\.json$/.test(item.key)) {
				const run = JobRunSchema.parse(await object.json());
				if (run.output) {
					if (run.output.html_bytes > 0)
						await requireKey(`${item.key.slice(0, -'run.json'.length)}output.html`);
					if (run.output.logs_bytes !== undefined)
						await requireKey(`${item.key.slice(0, -'run.json'.length)}logs.txt`);
				}
			}
			if (item.key.endsWith('/proposal.json')) {
				const proposal = NotebookProposalSchema.parse(await object.json());
				const prunable =
					Date.now() >=
					Date.parse(proposal.created_at) +
						DEFAULT_PROPOSAL_PAYLOAD_RETENTION_MS +
						DEFAULT_PROPOSAL_PAYLOAD_SWEEP_GRACE_MS;
				for (const [index, change] of proposal.changes.entries())
					if (change.operation !== 'delete') {
						const key = `${item.key.slice(0, -'proposal.json'.length)}changes/${index}`;
						const artifact = await bucket.get(key);
						if (!artifact && prunable) continue;
						if (
							!artifact ||
							artifact.size !== change.size_bytes ||
							(await proposalSha256(await artifact.bytes())) !== change.sha256
						)
							throw new Error(`Invalid referenced proposal artifact: ${key}`);
					}
			}
			if (item.key.startsWith('_system/sessions/')) {
				const session = SessionSchema.parse(await object.json());
				if (item.key !== paths.session(session.project_id, session.session_id))
					throw new Error('Session identity mismatch');
				if (
					['starting', 'running'].includes(session.status) ||
					(session.sandbox_id && !session.sandbox_reclaimed_at) ||
					(session.stop && !['stopped', 'retained'].includes(session.stop.outcome))
				)
					throw new Error('Drain and reclaim sessions before metadata transfer');
			}
			const match = /^projects\/([^/]+)\/notebooks\/([^/]+)\/source\.json$/.exec(item.key);
			if (match) {
				const source = SourceSchema.parse(await object.json());
				if (source.type !== 'local') continue;
				const notebook = paths.project(match[1] as ProjectId).notebook(match[2] as NotebookId);
				for (const entry of source.publication?.versions ?? [
					{ version_id: source.current_version_id },
				]) {
					const version = notebook.version(entry.version_id);
					await requireKey(version.meta);
					await requireKey(version.code);
					for (const [field, kind] of [
						['html_snapshot', 'html'],
						['session_snapshot', 'session'],
					] as const) {
						const descriptor = entry[field];
						if (descriptor)
							await requireKey(
								descriptor.capture_id
									? version.capture(descriptor.capture_id)[kind]
									: version[kind],
							);
					}
				}
			}
		}
		cursor = page.cursor;
	} while (cursor);
}
