import type { NotebookId, ProjectId, UserId } from '../ids';
import { paths } from '../paths';
import type { Bucket } from '../ports/bucket';
import type { Source } from '../schema';
import { NotebookWorkspaceService } from '../services/content/NotebookWorkspaceService';
import type { NotebookDetail } from '../services/content/NotebookService';
import { makeLocalSource, makeNotebookMeta } from './fixtures';

export interface SavedSourceFile {
	projectId: ProjectId;
	notebookId: NotebookId;
	path: 'notebook.py' | 'pyproject.toml';
	content: string;
	actor: UserId;
}

/** The mutable owner state behind a `makeWorkspaceService` instance. */
export interface FakeWorkspaceOwner {
	/** Swap the source to exercise git-backed or unsynced policies mid-test. */
	detail: NotebookDetail;
	/** Every source edit routed through the owner, oldest first. */
	saved: SavedSourceFile[];
}

export function fakeNotebookDetail(source: Source = makeLocalSource()): NotebookDetail {
	return { meta: makeNotebookMeta(), readme: null, source };
}

/**
 * A `NotebookWorkspaceService` over `bucket` whose owner answers with a fixed
 * notebook and mirrors source edits into `workspace/` like `NotebookService` does.
 */
export function makeWorkspaceService(
	bucket: Bucket,
	source: Source = makeLocalSource(),
): { service: NotebookWorkspaceService; owner: FakeWorkspaceOwner } {
	const owner: FakeWorkspaceOwner = { detail: fakeNotebookDetail(source), saved: [] };
	const service = new NotebookWorkspaceService(bucket, {
		getNotebook: async () => owner.detail,
		saveSourceFile: async (projectId, notebookId, path, content, actor) => {
			owner.saved.push({ projectId, notebookId, path, content, actor });
			await bucket.put(paths.project(projectId).notebook(notebookId).workspaceFile(path), content);
		},
	});
	return { service, owner };
}
