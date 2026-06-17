/**
 * Per-backend Setup snippets — the SAME markdown the docs port pages render via
 * `<!--@include-->`. Loaded here as raw strings so the wizard's Setup accordion
 * shows identical content, plus a deep link to the matching docs heading.
 */
import type { GroupKey } from './spec';

// Body-only partials live in repo-root docs/setup/<port>/<value>.md.
const RAW = import.meta.glob('../../../../docs/setup/**/*.md', {
	query: '?raw',
	import: 'default',
	eager: true,
}) as Record<string, string>;

/** `${port}/${value}` -> snippet markdown (HTML author comments stripped). */
const SNIPPETS: Record<string, string> = {};
for (const [path, content] of Object.entries(RAW)) {
	const m = path.match(/setup\/([^/]+)\/([^/]+)\.md$/);
	if (m) SNIPPETS[`${m[1]}/${m[2]}`] = content.replaceAll(/<!--[\s\S]*?-->/g, '').trimStart();
}

/**
 * Deep link to the matching docs heading. Anchors are the VitePress slugs of the
 * headings in docs/{auth,compute,storage,ai}.md (kept explicit so they don't drift
 * silently if a heading is reworded).
 */
const DOC_HREFS: Record<string, string> = {
	'auth/oidc': '/auth#oidc-production',
	'auth/dev': '/auth#dev-bypass',
	'storage/s3': '/storage#s3-compatible-setup',
	'storage/gcs': '/storage#google-cloud-storage',
	'storage/memory': '/storage#memory-dev-tests',
	'compute/coreweave': '/compute#coreweave',
	'compute/modal': '/compute#modal',
	'compute/e2b': '/compute#e2b',
	'compute/kubernetes': '/compute#kubernetes',
	'compute/docker': '/compute#docker',
	'compute/local': '/compute#local-dev',
	'compute/none': '/compute#none',
	'ai/openai-compatible': '/ai#configuration',
	'ai/none': '/ai#what-the-user-can-override',
};

export interface SetupInfo {
	markdown: string;
	docHref: string;
}

/** Setup snippet + docs deep link for a selected backend, or undefined if none. */
export function getSetup(port: GroupKey, value: string): SetupInfo | undefined {
	const key = `${port}/${value}`;
	const markdown = SNIPPETS[key];
	if (markdown === undefined) return undefined;
	return { markdown, docHref: DOC_HREFS[key] ?? `/${port}` };
}
