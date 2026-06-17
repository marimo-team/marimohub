/**
 * Schema-conformance guard (Plan 009, Part B — conformance approach).
 *
 * The domain shapes live ONCE, as the zod schemas in `@marimo-hub/core`. The
 * OpenAPI response schemas in `./shared` are NOT re-derived at runtime from the
 * core schemas, because the published OpenAPI document must stay byte-identical
 * and the API copies differ from core in deliberate, doc-affecting ways:
 *
 *   - `schema_version` is `z.literal(1)` (doc: `enum [1]`) vs core's
 *     forward-tolerant `z.number().int().positive()`.
 *   - datetime fields use the `dt()` helper (a plain `z.string()` carrying an
 *     OpenAPI `format`/`example`) vs core's `z.iso.datetime()`.
 *   - id fields are plain `z.string()` (no `pattern`) vs core's branded
 *     regex+transform schemas.
 *   - the public response shapes omit internal fields (`key_prefix` on notebook
 *     entries; `user_id` / `runtime` / `sandbox_id` / `used_fallback` on
 *     sessions).
 *
 * Deriving the response schemas from core would therefore CHANGE the contract,
 * so instead this guard asserts the two stay in sync at the FIELD level. It
 * compares the actual zod `.shape` key sets (not value types — the narrowing
 * differences above are intentional). Adding a field to a core schema without
 * reflecting it in the API response schema (or vice versa) fails this test, so
 * the OpenAPI contract can no longer silently lie about the core shape.
 *
 * Why runtime (not purely type-level): the repo's `pnpm check` and `pnpm build`
 * do not run `tsc` over `*.test.ts` files, so a `type Expect<...>` assertion
 * here would never be evaluated. A `pnpm test` (vitest) runtime check on the
 * real schema shapes is what actually exercises the guard.
 */

import { describe, expect, it } from 'vitest';
import {
	NotebookMetaSchema as CoreNotebookMetaSchema,
	ProjectMemberSchema as CoreProjectMemberSchema,
	ProjectSchema as CoreProjectSchema,
	SessionSchema as CoreSessionSchema,
	SnapshotNotebookEntrySchema as CoreSnapshotNotebookEntrySchema,
	SnapshotProjectEntrySchema as CoreSnapshotProjectEntrySchema,
	VersionSchema as CoreVersionSchema,
	LocalSourceSchema as CoreLocalSourceSchema,
	GithubSourceSchema as CoreGithubSourceSchema,
} from '@marimo-hub/core';
import {
	NotebookMetaResponseSchema,
	ProjectMemberResponseSchema,
	ProjectResponseSchema,
	SessionResponseSchema,
	SnapshotNotebookEntrySchema,
	SnapshotProjectEntrySchema,
	SourceResponseSchema,
	VersionResponseSchema,
	LocalSourceResponseSchema,
	GithubSourceResponseSchema,
} from './shared';

/** Sorted key set of a zod object schema (tolerates `.openapi()` wrapping). */
function shapeKeys(schema: unknown): string[] {
	const s = schema as {
		shape?: Record<string, unknown>;
		_def?: { shape?: Record<string, unknown> };
	};
	const shape = s.shape ?? s._def?.shape;
	if (!shape) throw new Error('expected a zod object schema with a .shape');
	return Object.keys(shape).sort();
}

describe('schema conformance: api response shapes vs core public shapes', () => {
	// Same field set on both sides — the API response is exactly the core shape.
	const identical: Array<[string, unknown, unknown]> = [
		['Project', ProjectResponseSchema, CoreProjectSchema],
		['ProjectMember', ProjectMemberResponseSchema, CoreProjectMemberSchema],
		['SnapshotProjectEntry', SnapshotProjectEntrySchema, CoreSnapshotProjectEntrySchema],
		['NotebookMeta', NotebookMetaResponseSchema, CoreNotebookMetaSchema],
		['Version', VersionResponseSchema, CoreVersionSchema],
		['LocalSource', LocalSourceResponseSchema, CoreLocalSourceSchema],
		['GithubSource', GithubSourceResponseSchema, CoreGithubSourceSchema],
	];

	it.each(identical)('%s has the same field set as its core schema', (_name, api, core) => {
		expect(shapeKeys(api)).toEqual(shapeKeys(core));
	});

	// Public response shapes that deliberately omit internal fields. The api set
	// must equal the core set MINUS exactly the declared internal fields — this
	// catches both a new core field missing from the response AND an internal
	// field accidentally leaking into the response.
	it('SnapshotNotebookEntry omits exactly `key_prefix` from the core entry', () => {
		const coreKeys = shapeKeys(CoreSnapshotNotebookEntrySchema);
		const apiKeys = shapeKeys(SnapshotNotebookEntrySchema);
		expect(coreKeys.filter((k) => k !== 'key_prefix')).toEqual(apiKeys);
		expect(coreKeys).toContain('key_prefix');
	});

	it('Session omits exactly the internal fields from the core session', () => {
		const internalSessionFields = ['user_id', 'runtime', 'sandbox_id', 'used_fallback'];
		const coreKeys = shapeKeys(CoreSessionSchema);
		const apiKeys = shapeKeys(SessionResponseSchema);
		expect(coreKeys.filter((k) => !internalSessionFields.includes(k))).toEqual(apiKeys);
		for (const f of internalSessionFields) expect(coreKeys).toContain(f);
	});

	// The Source discriminated union members must each match their core member.
	it('Source union members match the core source members', () => {
		const apiOptions = (SourceResponseSchema as { _def: { options: unknown[] } })._def.options;
		expect(apiOptions.map(shapeKeys)).toEqual([
			shapeKeys(CoreLocalSourceSchema),
			shapeKeys(CoreGithubSourceSchema),
		]);
	});
});
