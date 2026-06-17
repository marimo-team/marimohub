import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { renderConfigDocs } from './configDocs';
import { CONFIG_SPEC } from './spec';

/**
 * The committed, human-readable config reference. It is rendered from the config
 * registry (`spec.ts`), and this test fails the build if it drifts.
 *
 * Regenerate it with:  pnpm --filter @marimo-hub/config docs:generate
 */
const DOC_PATH = fileURLToPath(new URL('../../../docs/configuration.md', import.meta.url));

const doc = renderConfigDocs(CONFIG_SPEC);

// The `docs:generate` script sets UPDATE_CONFIG_DOCS to rewrite the committed
// doc from the registry rather than asserting against it.
if (process.env.UPDATE_CONFIG_DOCS) {
	writeFileSync(DOC_PATH, doc);
}

describe('config docs', () => {
	it('docs/configuration.md is in sync with the registry (run `pnpm --filter @marimo-hub/config docs:generate` to update)', () => {
		const committed = readFileSync(DOC_PATH, 'utf8');
		expect(committed).toEqual(doc);
	});
});
