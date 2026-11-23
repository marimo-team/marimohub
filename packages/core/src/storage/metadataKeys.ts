import { MetadataTransferError } from '../errors';
export const METADATA_MANIFEST_VERSION = 1;
export const METADATA_BACKEND_KEY = '_system/metadata-backend.json';
export type StoragePlacement = 'metadata' | 'artifact' | 'control';

export const MAINTENANCE_LOCK_KEY_PATTERN =
	/^_system\/(?:_(?:maintenance|session_lifecycle|jobs|warm_pool)\.lock|search\/lock\.json|(?:app-pool-maintenance|retention-(?:notebook_gc|snapshot_expiry|jobs))-lock\.json)$/;

const systemRecords = [
	/^_system\/(catalog|host-retry-cleanup|preview-work|preview-cleanup-cursor|source-control-account-cleanup|snapshot-expiry-cursor|job-prune-cursor|notebook-gc-cursor|notebook-purge-cursor|project-purge-cursor)\.json$/,
	MAINTENANCE_LOCK_KEY_PATTERN,
	/^_system\/(migrations|notebook-moves|deep-links|snapshots|warm-pools|identities|tokens|cli-authorizations|cli-device-user-codes|oauth-clients|oauth-authorizations|oauth-rate-limits|host-retries|idempotency|sandbox-diagnostics|preview-projects|preview-receipts)\/[^/]+\.json$/,
	/^_system\/(sessions|version-prune-cutoffs|apps|app-pools|editors|job-runs|preview-automations|preview-active-projects|source-control-accounts)\/[^/]+\/[^/]+\.json$/,
	/^_system\/session-index\/users\/[^/]+\.json$/,
	/^_system\/reconcile\/orphans\/[^/]+\.json$/,
	/^_system\/(proposal-payloads|job-operations|job-deletions|previews)\/[^/]+\/[^/]+\/[^/]+\.json$/,
	/^_system\/events\/[^/]+\/(?:_idempotency\/)?[^/]+\.json$/,
	/^_system\/search\/cursor\.json$/,
	/^_system\/search\/projects\/[^/]+\/[^/]+\/(head|crawl)\.json$/,
	/^_system\/search\/projects\/[^/]+\/[^/]+\/(pages|snapshots)\/[^/]+\.json$/,
	/^_system\/working-branches\/cleanup\.json$/,
	/^_system\/working-branches\/creations\/[^/]+\/[^/]+\.json$/,
	/^_system\/working-branches\/notebooks\/[^/]+\/[^/]+\/head\.json$/,
	/^_system\/working-branches\/notebooks\/[^/]+\/[^/]+\/saves\/[^/]+\/receipt\.json$/,
];

const notebookRecords = [
	/^(meta|preview-runtime|source|fs_snapshot|integration_sync_token|workspace_mutation_claim|thumbnail)\.json$/,
	/^(thumbnail-attempts|deep-links|job-index)\/[^/]+\.json$/,
	/^versions\/[^/]+\/(version|workspace-manifest)\.json$/,
	/^proposals\/[^/]+\/(proposal|publication)\.json$/,
	/^jobs\/[^/]+\/job\.json$/,
	// Existing pruning cursors contain a double slash after the job prefix.
	/^jobs\/[^/]+\/\/?prune-(runs|occurrences)\.json$/,
	/^jobs\/[^/]+\/(occurrences|run-index)\/[^/]+\.json$/,
	/^jobs\/[^/]+\/runs\/[^/]+\/run\.json$/,
];

const notebookArtifacts = [
	/^README\.md$/,
	/^workspace\/.+$/,
	/^thumbnails\/[^/]+\.png$/,
	/^proposals\/[^/]+\/changes\/[^/]+$/,
	/^versions\/[^/]+\/(notebook\.py|pyproject\.toml|workspace\.zip|notebook\.html|session\.json)$/,
	/^versions\/[^/]+\/(workspace|git)\/.+$/,
	/^versions\/[^/]+\/captures\/[^/]+\/(notebook\.html|session\.json)$/,
	/^jobs\/[^/]+\/runs\/[^/]+\/(output\.html|logs\.txt)$/,
];

function uploadPlacement(key: string): StoragePlacement | undefined {
	if (/^[^/]+\.json$/.test(key)) return 'metadata';
	if (/^[^/]+\/parts\/[^/]+$/.test(key)) return 'artifact';
	return undefined;
}

export function classifyMetadataKey(key: string): StoragePlacement {
	if (key === METADATA_BACKEND_KEY) return 'control';
	if (systemRecords.some((rule) => rule.test(key))) return 'metadata';
	if (/^_system\/working-branches\/notebooks\/[^/]+\/[^/]+\/saves\/[^/]+\/capture\.json$/.test(key))
		return 'artifact';
	if (
		/^(?:_system|projects\/[^/]+)\/integrations\/(?:_names\/[^/]+\.json|[^/]+\/(?:integration\.json|versions\/[^/]+\.json))$/.test(
			key,
		)
	)
		return 'metadata';
	const project = /^projects\/[^/]+\/(.+)$/.exec(key)?.[1];
	if (project) {
		if (/^run-index\/[^/]+\.json$/.test(project)) return 'metadata';
		if (
			/^(project|alerts)\.json$/.test(project) ||
			/^conversations\/[^/]+\/[^/]+\.json$/.test(project) ||
			/^chat-permissions\/[^/]+\.json$/.test(project)
		)
			return 'metadata';
		if (/^imports\/[^/]+\/(preparation\.json|items\/[^/]+\.json)$/.test(project)) return 'metadata';
		if (/^imports\/[^/]+\/snapshot\.zip$/.test(project)) return 'artifact';
		const objectUpload = project.startsWith('object-uploads/')
			? uploadPlacement(project.slice('object-uploads/'.length))
			: undefined;
		if (objectUpload) return objectUpload;
		const notebook = /^notebooks\/[^/]+\/(.+)$/.exec(project)?.[1];
		if (notebook) {
			if (notebookRecords.some((rule) => rule.test(notebook))) return 'metadata';
			if (notebookArtifacts.some((rule) => rule.test(notebook))) return 'artifact';
			const upload = notebook.startsWith('uploads/')
				? uploadPlacement(notebook.slice('uploads/'.length))
				: undefined;
			if (upload) return upload;
		}
	}
	throw new MetadataTransferError(`Unclassified storage key: ${key}`);
}
