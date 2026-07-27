import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_SPEC } from '@marimo-hub/config/spec';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DOCS_ROOT = path.join(REPO_ROOT, 'docs');
const OPENAPI_PATH = path.join(REPO_ROOT, 'packages/api/openapi.yaml');
const MANUALLY_WIRED_SELECTORS: Partial<Record<string, string[]>> = {
	Compute: ['cloudflare'],
};

function markdownFiles(dir: string): string[] {
	return readdirSync(dir)
		.sort()
		.flatMap((entry) => {
			const fullPath = path.join(dir, entry);
			return statSync(fullPath).isDirectory()
				? markdownFiles(fullPath)
				: entry.endsWith('.md')
					? [fullPath]
					: [];
		});
}

function slugify(heading: string): string {
	return heading
		.normalize('NFKD')
		.replaceAll(/['"]/g, '')
		.replaceAll(/[\s~`!@#$%^&*()\-+=[\]{}|\\;:<>,.?/]+/g, '-')
		.replaceAll(/-{2,}/g, '-')
		.replaceAll(/^-+|-+$/g, '')
		.replace(/^(\d)/, '_$1')
		.toLowerCase();
}

function anchors(file: string): Set<string> {
	const source = readFileSync(file, 'utf8').replaceAll(/```[\s\S]*?```/g, '');
	return new Set([...source.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((match) => slugify(match[1])));
}

function resolveDocsTarget(sourceFile: string, href: string): string | undefined {
	const pathname = decodeURIComponent(href.split('#')[0].split('?')[0]);
	if (!pathname) return sourceFile;
	if (pathname === '/openapi.yaml') return OPENAPI_PATH;

	const base = pathname.startsWith('/')
		? path.join(DOCS_ROOT, pathname)
		: path.resolve(path.dirname(sourceFile), pathname);
	const candidates = path.extname(base)
		? [base]
		: [base, `${base}.md`, path.join(base, 'README.md'), path.join(base, 'index.md')];
	return candidates.find(existsSync);
}

function selectorsInTable(file: string): string[] {
	const source = readFileSync(file, 'utf8');
	const section = source.match(/## Choose a backend\n([\s\S]*?)(?=\n## )/)?.[1] ?? '';
	return [...section.matchAll(/^\|[^|\n]+\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1]).sort();
}

function registrySelectors(groupName: string): string[] {
	const group = CONFIG_SPEC.find((candidate) => candidate.name === groupName);
	if (!group) throw new Error(`Missing CONFIG_SPEC group: ${groupName}`);
	return group.backends
		.map((backend) => backend.selectorValue)
		.filter((value): value is string => value !== undefined)
		.sort();
}

function expectedSelectors(groupName: string): string[] {
	return [...registrySelectors(groupName), ...(MANUALLY_WIRED_SELECTORS[groupName] ?? [])].sort();
}

describe('docs content integrity', () => {
	const files = markdownFiles(DOCS_ROOT);

	it('all local Markdown links resolve to a target and heading', () => {
		const failures: string[] = [];

		for (const sourceFile of files) {
			const source = readFileSync(sourceFile, 'utf8').replaceAll(/```[\s\S]*?```/g, '');
			for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
				const href = match[1];
				if (/^(?:[a-z]+:|\/\/)/i.test(href)) continue;

				const target = resolveDocsTarget(sourceFile, href);
				const relSource = path.relative(DOCS_ROOT, sourceFile);
				if (!target) {
					failures.push(`${relSource}: missing target ${href}`);
					continue;
				}

				const fragment = href.split('#')[1]?.split('?')[0];
				if (fragment && target.endsWith('.md') && !anchors(target).has(fragment)) {
					failures.push(`${relSource}: missing heading #${fragment} in ${href}`);
				}
			}
		}

		expect(failures).toEqual([]);
	});

	it('backend summary tables match the authoritative selectors', () => {
		expect(selectorsInTable(path.join(DOCS_ROOT, 'storage.md'))).toEqual(
			expectedSelectors('Storage'),
		);
		expect(selectorsInTable(path.join(DOCS_ROOT, 'compute.md'))).toEqual(
			expectedSelectors('Compute'),
		);
		expect(selectorsInTable(path.join(DOCS_ROOT, 'auth.md'))).toEqual(expectedSelectors('Auth'));

		const architecture = readFileSync(path.join(DOCS_ROOT, 'architecture.md'), 'utf8');
		for (const groupName of ['Storage', 'Compute', 'Auth']) {
			const row = architecture.split('\n').find((line) => line.startsWith(`| **${groupName}**`));
			expect(row, `${groupName} architecture row`).toBeDefined();
			for (const selector of expectedSelectors(groupName)) {
				expect(row).toContain(`\`${selector}\``);
			}
		}
	});

	it('Helm examples use a release placeholder instead of invented versions', () => {
		const offenders = files.flatMap((file) => {
			const source = readFileSync(file, 'utf8');
			return /--version\s+v?\d+\.\d+\.\d+/.test(source) ? [path.relative(DOCS_ROOT, file)] : [];
		});
		expect(offenders).toEqual([]);
	});

	it('the docs OpenAPI artifact reads from the committed API specification', () => {
		expect(readFileSync(OPENAPI_PATH, 'utf8')).toMatch(/^openapi: 3\.1\.0/m);
	});
});
