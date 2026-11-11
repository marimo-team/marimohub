import { createHash } from 'node:crypto';

// Runs before the entry module so route data overlaps its dependency downloads.
export const SHELL_PREFETCH_SCRIPT = `(() => {
const base = new URL(document.baseURI);
const path = location.pathname.startsWith(base.pathname) ? location.pathname.slice(base.pathname.length) : '';
const urls = ['me', 'capabilities', 'theme'];
const parts = path.split('/');
const id = /^[a-zA-Z0-9_-]+$/;
if ((!path || path === 'index.html') && !location.search) urls.push('projects?status=active&limit=1');
if (parts[0] === 'projects' && id.test(parts[1] || '')) {
  const project = 'projects/' + parts[1];
  urls.push(project);
  if (parts[2] === 'notebooks' && id.test(parts[3] || '') && parts.length === 4) urls.push(project + '/notebooks/' + parts[3] + '/app');
  else if (parts.length === 2 || (parts.length === 3 && parts[2] === '')) {
    const search = new URLSearchParams(location.search);
    const filters = new URLSearchParams({limit: '100'});
    for (const key of ['q', 'status', 'tag']) {
      const value = search.get(key)?.trim();
      if (value && (key !== 'status' || ['active', 'draft', 'archived', 'deleted'].includes(value))) filters.set(key, value);
    }
    urls.push(project + '/sessions', project + '/notebooks?' + filters);
  }
}
const responses = Object.create(null);
window.__MARIMOHUB_PREFETCH__ = {createdAt: Date.now(), responses};
for (const path of urls) {
  const url = new URL('api/v1/' + path, base);
  url.searchParams.sort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  responses[url.href] = fetch(url, {credentials: 'include', headers: {Accept: 'application/json'}, signal: controller.signal}).then(response => response.ok ? response : null, () => null).finally(() => clearTimeout(timer));
}
setTimeout(() => { if (window.__MARIMOHUB_PREFETCH__?.responses === responses) delete window.__MARIMOHUB_PREFETCH__; }, 30000);
})();`;

export const SHELL_PREFETCH_CSP = `'sha256-${createHash('sha256').update(SHELL_PREFETCH_SCRIPT).digest('base64')}'`;

// The script's fetches cannot reuse the shell's `as="fetch"` preloads (their credentials modes
// differ), so keeping both would request each URL twice.
const FETCH_PRELOAD = /<link\b(?=[^>]*\brel=["']?preload\b)(?=[^>]*\bas=["']?fetch\b)[^>]*>\s*/gi;

const BASE_TAG = /(<base\s[^>]*>)/i;

export function injectShellPrefetch(html: string): string {
	if (!BASE_TAG.test(html)) return html;
	return html
		.replace(FETCH_PRELOAD, '')
		.replace(BASE_TAG, `$1<script>${SHELL_PREFETCH_SCRIPT}</script>`);
}
