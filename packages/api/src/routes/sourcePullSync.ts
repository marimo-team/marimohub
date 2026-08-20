import {
	effectiveGitSourceConfig,
	isAtBranchHead,
	NotFoundError,
	providerForRepo,
	SyncNotConfiguredError,
} from '@marimo-hub/core';
import type {
	GitSource,
	GitSourceConfig,
	NotebookId,
	ProjectId,
	Source,
	SourceBranchHead,
	SourceControlReader,
	UserId,
} from '@marimo-hub/core';
import type { ApiDeps } from '../context';

type PullSyncDeps = Pick<ApiDeps, 'services' | 'sourceControl'>;

export interface SyncTarget {
	git: GitSource;
	reader: SourceControlReader;
	/** Pending coordinates when present — a pull that satisfies pending settings must promote them, exactly like a push. */
	config: GitSourceConfig;
	head: SourceBranchHead;
}

function requireSyncReader(
	deps: PullSyncDeps,
	source: Source,
): { git: GitSource; reader: SourceControlReader; config: GitSourceConfig } {
	if (source.type !== 'git') {
		throw new NotFoundError('Notebook is not backed by a synced source');
	}
	// Dispatch on the effective repository, not the stored provider: a pending
	// settings edit may move the source between providers, and a provider match
	// alone is not enough — host detection labels e.g. GitHub Enterprise as
	// `github` while the reader serves github.com only.
	const config = effectiveGitSourceConfig(source);
	const provider = providerForRepo(source, config.repo);
	const reader = provider ? deps.sourceControl?.getReader(provider) : undefined;
	if (!reader?.supportsRepository(config.repo)) throw new SyncNotConfiguredError();
	return { git: source, reader, config };
}

/** Resolve the reader and live branch head for a notebook's effective sync coordinates. */
export async function resolveSyncTarget(deps: PullSyncDeps, source: Source): Promise<SyncTarget> {
	const { git, reader, config } = requireSyncReader(deps, source);
	const head = await reader.getBranchHead(config.repo, config.branch);
	return { git, reader, config, head };
}

export interface PullSyncOutcome {
	synced: boolean;
	commit: string;
	version_id: string | null;
}

/**
 * Server-initiated pull sync: fetch the branch head and ingest it through the
 * exact path a pushed archive takes, so pull-created versions are
 * indistinguishable from push-created ones, including commit idempotency.
 */
export async function pullSourceToHead(
	deps: PullSyncDeps,
	projectId: ProjectId,
	notebookId: NotebookId,
	actor: UserId,
): Promise<PullSyncOutcome> {
	const { notebooks } = deps.services;
	const { source } = await notebooks.getNotebook(projectId, notebookId);
	const { git, reader, config, head } = await resolveSyncTarget(deps, source);
	if (isAtBranchHead(git, head.commit)) {
		return { synced: false, commit: head.commit, version_id: null };
	}
	const files = await reader.fetchWorkspace(config.repo, head.commit, config.root_path);
	const { versionId } = await notebooks.synced.sync(
		projectId,
		notebookId,
		{
			repo: config.repo,
			branch: config.branch,
			root_path: config.root_path,
			commit: head.commit,
			files,
			// The head was resolved against this source state; if another sync
			// advances it during the download, conflict instead of regressing.
			expected_commit: git.commit,
		},
		actor,
	);
	// A null versionId means a concurrent sync of the same commit won the
	// advance while this one downloaded — report the truthful "already there"
	// so the audit trail never credits this request with a sync it didn't do.
	if (versionId === null) {
		return { synced: false, commit: head.commit, version_id: null };
	}
	return { synced: true, commit: head.commit, version_id: versionId };
}
