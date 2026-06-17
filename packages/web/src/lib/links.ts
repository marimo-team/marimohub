// External docs links surfaced in the UI. GitHub for now; swap for hosted docs later.
const DOCS_BASE = 'https://github.com/marimo-team/marimo-hub/blob/main/docs';

export const DOCS_FEDERATION_URL = `${DOCS_BASE}/coreweave-bucket-access.md`;
export const DOCS_SYNCING_URL = `${DOCS_BASE}/syncing.md`;

/**
 * The push-sync endpoint a CI workflow posts archives to. Derived from the
 * current origin so it matches whatever host the app is served from — the same
 * URL the create/rotate API returns.
 */
export function syncUrl(projectId: string, notebookId: string): string {
	return `${window.location.origin}/api/sync/git/v1/projects/${projectId}/notebooks/${notebookId}`;
}
