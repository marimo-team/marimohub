import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parse, stringify } from 'yaml';
import { generateOpenApiDocument } from './createApi';

/**
 * The committed, human-readable OpenAPI 3.1 spec. It is the single source of
 * truth for `@marimo-hub/client`'s type codegen, and this test fails the build if
 * it drifts from the live route definitions.
 *
 * Regenerate it with:  pnpm --filter @marimo-hub/api openapi:generate
 */
const SPEC_PATH = fileURLToPath(new URL('../openapi.yaml', import.meta.url));

const doc = generateOpenApiDocument();

// The `openapi:generate` script sets UPDATE_OPENAPI to rewrite the committed
// spec from `generateOpenApiDocument()` rather than asserting against it.
if (process.env.UPDATE_OPENAPI) {
	writeFileSync(SPEC_PATH, stringify(doc));
}

describe('OpenAPI spec', () => {
	it('openapi.yaml is in sync with the live API (run `pnpm --filter @marimo-hub/api openapi:generate` to update)', () => {
		const committed = parse(readFileSync(SPEC_PATH, 'utf8'));
		expect(committed).toEqual(doc);
	});
});
