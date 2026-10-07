import { workspaceSourcePolicy } from '../../integrations/remoteWorkspace';
import type { Source } from '../../schema';

export type PersistenceMode = 'source' | 'workspace' | 'none';

/**
 * What a session's teardown actually writes back. The sandbox context reports
 * this to the notebook, so it must stay the same rule `captureSession` applies.
 */
export function effectivePersistenceMode(input: {
	/** `sessionPersistsEdits(session)`; false for discard-only sessions and app sandboxes. */
	persistEdits: boolean;
	source: Source;
	persistWorkspace: 'source' | 'workspace';
}): PersistenceMode {
	if (!input.persistEdits) return 'none';
	if (!workspaceSourcePolicy(input.source).persistSessionEdits) return 'none';
	// Explicit local entrypoints carry imported workspaces, including root notebook.py.
	if (input.source.type === 'local' && input.source.entry_notebook) return 'workspace';
	return input.persistWorkspace;
}
