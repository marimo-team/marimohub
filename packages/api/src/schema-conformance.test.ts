/**
 * Schema-conformance guard.
 *
 * The domain shapes live ONCE, as the zod schemas in `@marimo-hub/core`. The
 * OpenAPI response schemas in `./shared` are NOT re-derived at runtime from the
 * core schemas, because the published OpenAPI document must stay byte-identical
 * and the API copies differ from core in deliberate, doc-affecting ways:
 *
 *   - `schema_version` is an internal persistence field, omitted from the public
 *     response shapes entirely (the detail responses project through `toPublic*`).
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
	GitSourceSchema as CoreGitSourceSchema,
} from '@marimo-hub/core';
import {
	NotebookMetaResponseSchema,
	ProjectMemberResponseSchema,
	ProjectResponseSchema,
	SessionResponseSchema,
	SnapshotNotebookEntrySchema,
	SnapshotProjectEntrySchema,
	SourceResponseSchema,
	NotebookVersionResponseSchema,
	LocalSourceResponseSchema,
	GitSourceResponseSchema,
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
	const identical: [string, unknown, unknown][] = [
		['ProjectMember', ProjectMemberResponseSchema, CoreProjectMemberSchema],
	];

	it.each(identical)('%s has the same field set as its core schema', (_name, api, core) => {
		expect(shapeKeys(api)).toEqual(shapeKeys(core));
	});

	// Response shapes that omit exactly `schema_version` (internal persistence field).
	const omitsSchemaVersion: [string, unknown, unknown][] = [
		['NotebookMeta', NotebookMetaResponseSchema, CoreNotebookMetaSchema],
		['NotebookVersion', NotebookVersionResponseSchema, CoreVersionSchema],
		['LocalSource', LocalSourceResponseSchema, CoreLocalSourceSchema],
		['GitSource', GitSourceResponseSchema, CoreGitSourceSchema],
	];

	it.each(omitsSchemaVersion)('%s omits exactly `schema_version`', (_name, api, core) => {
		const coreKeys = shapeKeys(core);
		expect(coreKeys.filter((k) => k !== 'schema_version')).toEqual(shapeKeys(api));
		expect(coreKeys).toContain('schema_version');
	});

	// Project omits `schema_version` and adds the request-scoped `your_role`.
	it('Project omits `schema_version` and adds `your_role`', () => {
		const coreKeys = shapeKeys(CoreProjectSchema);
		const expected = [...coreKeys.filter((k) => k !== 'schema_version'), 'your_role'].sort();
		expect(shapeKeys(ProjectResponseSchema)).toEqual(expected);
		expect(coreKeys).toContain('schema_version');
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

	// The project-list response drops the nested `notebooks` roster (unbounded,
	// defeats the page cursor) and the denormalized filtering aids.
	// `notebook_count` stays for the summary; clients page
	// `GET /projects/{pid}/notebooks`.
	it('SnapshotProjectEntry omits internal list-filter fields from the core entry', () => {
		const coreKeys = shapeKeys(CoreSnapshotProjectEntrySchema);
		const apiKeys = shapeKeys(SnapshotProjectEntrySchema);
		const internal = ['notebooks', 'tags', 'member_ids', 'member_emails'];
		expect(coreKeys.filter((k) => !internal.includes(k))).toEqual(apiKeys);
		expect(coreKeys).toEqual(expect.arrayContaining(internal));
	});

	it('Session omits exactly the internal fields from the core session', () => {
		// `user_id` is intentionally surfaced (the "started by" attribution UI); the
		// remaining fields are compute internals that stay server-side. The
		// lifecycle-sweep bookkeeping (`expires_at`, `last_snapshot_at`,
		// `authorization_expires_at`, `sandbox_reclaimed_at`,
		// `takeover_capture_completed_at`) stays internal until the UI surfaces the
		// deadline.
		const internalSessionFields = [
			'runtime',
			'sandbox_id',
			'sandbox_origin_url',
			'used_fallback',
			'expires_at',
			'authorization_expires_at',
			'last_snapshot_at',
			'development_active_until',
			'sandbox_image',
			'sandbox_brokered_ports',
			'sandbox_reclaimed_at',
			'takeover_capture_completed_at',
		];
		// `can` is response-only: the caller's evaluated grants, computed per
		// request — never stored on the record.
		const responseOnlyFields = ['can', 'remote_development'];
		const coreKeys = shapeKeys(CoreSessionSchema);
		const apiKeys = shapeKeys(SessionResponseSchema);
		expect(coreKeys.filter((k) => !internalSessionFields.includes(k))).toEqual(
			apiKeys.filter((k) => !responseOnlyFields.includes(k)),
		);
		for (const f of internalSessionFields) expect(coreKeys).toContain(f);
		for (const f of responseOnlyFields) expect(apiKeys).toContain(f);
	});

	// The Source discriminated union members must each match their core member
	// (minus the omitted `schema_version`).
	it('Source union members match the core source members', () => {
		const apiOptions = (SourceResponseSchema as { _def: { options: unknown[] } })._def.options;
		const stripSchemaVersion = (keys: string[]) => keys.filter((k) => k !== 'schema_version');
		expect(apiOptions.map(shapeKeys)).toEqual([
			stripSchemaVersion(shapeKeys(CoreLocalSourceSchema)),
			stripSchemaVersion(shapeKeys(CoreGitSourceSchema)),
		]);
	});
});
