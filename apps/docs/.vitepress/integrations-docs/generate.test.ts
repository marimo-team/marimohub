import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { iconsBySlug, kindsOf, renderIntegrationPartials } from './generate';
import type { IntegrationsSpec } from './generate';

const SPEC_PATH = fileURLToPath(
	new URL('../../../../internal/schemas/integrations.yml', import.meta.url),
);
const PARTIALS_DIR = fileURLToPath(
	new URL('../../../../docs/partials/integrations', import.meta.url),
);
const PAGE_PATH = fileURLToPath(new URL('../../../../docs/integrations.md', import.meta.url));

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as IntegrationsSpec;
const partials = renderIntegrationPartials(spec);

// `integrations:generate` sets UPDATE_INTEGRATION_DOCS to rewrite the committed
// partials from the spec (removing stale ones) rather than asserting against them.
if (process.env.UPDATE_INTEGRATION_DOCS) {
	mkdirSync(PARTIALS_DIR, { recursive: true });
	for (const stale of readdirSync(PARTIALS_DIR)) {
		if (!partials.has(stale.replace(/\.md$/, ''))) rmSync(path.join(PARTIALS_DIR, stale));
	}
	for (const [kind, content] of partials) {
		writeFileSync(path.join(PARTIALS_DIR, `${kind}.md`), content);
	}
}

describe('integration docs partials', () => {
	it('docs/partials/integrations is in sync with the spec (run `pnpm schemas:generate` to update)', () => {
		const committed = readdirSync(PARTIALS_DIR).sort();
		expect(committed).toEqual([...partials.keys()].sort().map((kind) => `${kind}.md`));
		for (const [kind, content] of partials) {
			expect(readFileSync(path.join(PARTIALS_DIR, `${kind}.md`), 'utf8'), kind).toEqual(content);
		}
	});

	it('docs/integrations.md includes every kind partial', () => {
		const page = readFileSync(PAGE_PATH, 'utf8');
		for (const kind of partials.keys()) {
			expect(page, `add a section for ${kind} to docs/integrations.md`).toContain(
				`<!--@include: ./partials/integrations/${kind}.md-->`,
			);
		}
	});

	it('every kind has a well-formed brand color, and icons resolve with matching hex', () => {
		for (const [kind, item] of kindsOf(spec)) {
			expect(item['x-brand-color'], `${kind}: x-brand-color`).toMatch(/^#[0-9A-Fa-f]{6}$/);
			const slug = item['x-brand-icon'];
			if (slug === undefined) continue;
			const icon = iconsBySlug.get(slug);
			expect(icon, `${kind}: x-brand-icon ${slug} not found in simple-icons`).toBeDefined();
			expect(item['x-brand-color'], `${kind}: x-brand-color should match ${slug}`).toBe(
				`#${icon?.hex}`,
			);
		}
	});
});
