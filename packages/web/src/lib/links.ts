import { withBasePath } from './basePath';

export const DOCS_BASE = 'https://marimohub.docs.marimo.io';

export const DOCS_FEDERATION_URL = `${DOCS_BASE}/workload-identity-federation`;
export const DOCS_SYNCING_URL = `${DOCS_BASE}/syncing`;
export const DOCS_MCP_URL = `${DOCS_BASE}/mcp`;

/**
 * The push-sync endpoint a CI workflow posts archives to. Derived from the
 * current origin so it matches whatever host the app is served from — the same
 * URL the create/rotate API returns.
 */
export function syncUrl(projectId: string, notebookId: string): string {
	return `${window.location.origin}${withBasePath(`/api/sync/git/v1/projects/${projectId}/notebooks/${notebookId}`)}`;
}
