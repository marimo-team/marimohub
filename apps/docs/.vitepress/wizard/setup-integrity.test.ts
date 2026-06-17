/**
 * Drift guards for the Setup snippets:
 *  1. every `MARIMOHUB_*` token in a snippet is a real documented config var, and
 *  2. every wizard "Full docs" deep link points at a heading that actually exists
 *     on the target docs page.
 * Both catch silent breakage from renames/rewordings.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG_DOCUMENTED_IDS } from '@marimo-hub/config/spec';
import { getSetup } from './setup';
import { SELECTABLE_GROUPS } from './spec';

const SNIPPET_RAW = import.meta.glob('../../../../docs/setup/**/*.md', {
	query: '?raw',
	import: 'default',
	eager: true,
}) as Record<string, string>;

const PAGE_RAW = import.meta.glob('../../../../docs/*.md', {
	query: '?raw',
	import: 'default',
	eager: true,
}) as Record<string, string>;

// VitePress (@mdit-vue/shared) heading slugify, narrowed to ASCII headings
// (control-char and combining-mark strips omitted — our headings have neither).
const R_SPECIAL = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'<>,.?/]+/g;
function slugify(str: string): string {
	return str
		.normalize('NFKD')
		.replace(R_SPECIAL, '-')
		.replaceAll(/-{2,}/g, '-')
		.replaceAll(/^-+|-+$/g, '')
		.replace(/^(\d)/, '_$1')
		.toLowerCase();
}

/** route name (file basename) -> set of heading anchor slugs (code fences stripped). */
const PAGE_ANCHORS: Record<string, Set<string>> = {};
for (const [path, content] of Object.entries(PAGE_RAW)) {
	const name = path.split('/').pop()!.replace(/\.md$/, '');
	const body = content.replaceAll(/```[\s\S]*?```/g, '');
	const slugs = new Set<string>();
	for (const m of body.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) slugs.add(slugify(m[1]));
	PAGE_ANCHORS[name] = slugs;
}

describe('setup snippet integrity', () => {
	it('every MARIMOHUB_* token in a snippet is a documented config var', () => {
		const unknown = new Set<string>();
		for (const content of Object.values(SNIPPET_RAW)) {
			for (const m of content.matchAll(/MARIMOHUB_[A-Z0-9_]+/g)) {
				if (!CONFIG_DOCUMENTED_IDS.has(m[0])) unknown.add(m[0]);
			}
		}
		expect([...unknown]).toEqual([]);
	});

	it('every wizard "Full docs" deep link points at a real heading', () => {
		for (const group of SELECTABLE_GROUPS) {
			for (const backend of group.backends) {
				const setup = getSetup(group.key, backend.value);
				expect(setup, `${group.key}/${backend.value}`).toBeDefined();
				const [path, anchor] = setup!.docHref.split('#');
				const page = path.replace(/^\//, '');
				expect(anchor, `${group.key}/${backend.value} has an anchor`).toBeTruthy();
				expect(
					PAGE_ANCHORS[page]?.has(anchor),
					`${setup!.docHref} should resolve to #${anchor} on ${page}.md`,
				).toBe(true);
			}
		}
	});
});
