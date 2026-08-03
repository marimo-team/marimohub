import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from './config.mts';

interface LinkItem {
	link?: string;
	items?: LinkItem[];
}

const DOCS_ROOT = fileURLToPath(new URL('../../../docs', import.meta.url));
const EXCLUDED_DOCS = [/^README\.md$/, /^setup\//, /^partials\//];

function listMarkdownFiles(dir: string): string[] {
	const entries = readdirSync(dir).sort();
	const files: string[] = [];

	for (const entry of entries) {
		const fullPath = path.join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			files.push(...listMarkdownFiles(fullPath));
		} else if (entry.endsWith('.md')) {
			files.push(fullPath);
		}
	}

	return files;
}

function normalizeRoute(route: string): string {
	const clean = route.split('#')[0].split('?')[0];
	if (clean === '' || clean === '/') return '/';
	return clean.replace(/\/+$/, '');
}

function routeForDoc(file: string): string {
	const rel = path.relative(DOCS_ROOT, file).replaceAll(path.sep, '/');
	if (rel === 'index.md') return '/';
	if (rel === 'deploying/README.md') return '/deploying';
	return `/${rel.replace(/\.md$/, '')}`;
}

function collectLinks(items: LinkItem[] | undefined): string[] {
	if (!items) return [];
	const links: string[] = [];
	for (const item of items) {
		if (item.link) links.push(item.link);
		links.push(...collectLinks(item.items));
	}
	return links;
}

function internalRoute(link: string): string | undefined {
	if (/^[a-z]+:\/\//.test(link)) return undefined;
	if (!link.startsWith('/')) return undefined;
	return normalizeRoute(link);
}

describe('docs site structure', () => {
	const publicRoutes = new Set(
		listMarkdownFiles(DOCS_ROOT)
			.filter((file) => {
				const rel = path.relative(DOCS_ROOT, file).replaceAll(path.sep, '/');
				return !EXCLUDED_DOCS.some((pattern) => pattern.test(rel));
			})
			.map(routeForDoc)
			.map(normalizeRoute),
	);

	const themeConfig = config.themeConfig as {
		nav?: LinkItem[];
		sidebar?: LinkItem[] | Record<string, LinkItem[]>;
	};

	const sidebarItems = Array.isArray(themeConfig.sidebar)
		? themeConfig.sidebar
		: Object.values(themeConfig.sidebar ?? {}).flat();

	const linkedRoutes = new Set(
		[...collectLinks(themeConfig.nav), ...collectLinks(sidebarItems)]
			.map(internalRoute)
			.filter((route): route is string => route !== undefined),
	);

	it('every nav and sidebar link points at a public docs page', () => {
		const missing = [...linkedRoutes].filter((route) => !publicRoutes.has(route));
		expect(missing).toEqual([]);
	});

	it('every public docs page is present in nav or sidebar', () => {
		const unlisted = [...publicRoutes].filter((route) => !linkedRoutes.has(route));
		expect(unlisted).toEqual([]);
	});
});
