import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parse, stringify } from 'yaml';
import { buildBucketSpec } from './bucketSpec';
import { buildIntegrationsSpec } from './integrationsSpec';

/**
 * Generator and drift guard for the committed specs under `internal/schemas/`
 * (same pattern as the API's openapi.spec.test.ts): UPDATE_SCHEMAS rewrites
 * the files, otherwise the build fails when they no longer match the zod
 * schemas they are rendered from.
 *
 * Regenerate with:  pnpm schemas:generate
 */
const SPECS = [
	{ file: 'bucket.yml', doc: buildBucketSpec() },
	{ file: 'integrations.yml', doc: buildIntegrationsSpec() },
];

const specPath = (file: string) =>
	fileURLToPath(new URL(`../../../../internal/schemas/${file}`, import.meta.url));

if (process.env.UPDATE_SCHEMAS) {
	for (const { file, doc } of SPECS) {
		mkdirSync(dirname(specPath(file)), { recursive: true });
		// The docs reuse `$ref` objects, which would otherwise serialize as YAML
		// aliases (`*a1`) — valid, but mishandled by some OpenAPI tooling.
		writeFileSync(specPath(file), stringify(doc, { aliasDuplicateObjects: false }));
	}
}

describe.each(SPECS)('internal/schemas/$file', ({ file, doc }) => {
	it('is in sync with the zod schemas (run `pnpm schemas:generate` to update)', () => {
		const committed = parse(readFileSync(specPath(file), 'utf8'));
		expect(committed).toEqual(doc);
	});

	// zod emits `#/$defs/…` refs for cyclic schemas; inside an OpenAPI component
	// such a ref resolves against the document root and dangles. None of our
	// schemas are cyclic today — if one becomes so, hoist its defs instead.
	it('is self-contained (no document-root $defs refs)', () => {
		expect(JSON.stringify(doc)).not.toContain('#/$defs');
	});
});
