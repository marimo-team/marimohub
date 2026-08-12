/**
 * Shared behavioral contract for any kind's `BrowseCapability`, run against a
 * LIVE upstream (a real catalog or engine, typically in Docker). It pins the
 * cross-kind guarantees the data browser relies on — root listing shows only
 * roots, `parent` yields exactly the direct children, tables appear in their
 * namespace, and the schema round-trips — while each kind supplies its own
 * config, probe, and seeding.
 *
 * Suites gate themselves on a `MARIMOHUB_TEST_*` env var and stay skipped
 * otherwise; the catalog-conformance workflow provides the servers in CI.
 *
 * Imports `vitest` — only invoke from a `*.test.ts`. Exposed at the
 * `@marimo-hub/core/testing/browse-contract` subpath so it is never pulled
 * into runtime.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IntegrationProbe, TableColumn } from '../ports/integrations';
import type { BrowseCapability } from '../services/integrations/sdk';

export interface BrowseContractFixture {
	/** Run-unique root namespace the setup created. */
	root: string;
	/** Direct child namespaces the setup created under `root` (at least two). */
	children: string[];
	/**
	 * A namespace the setup created under `[root, children[0]]` — the tripwire
	 * proving a child listing is EXACT, not merely inclusive: an adapter that
	 * leaked deeper descendants would surface it one level too high.
	 */
	grandchild: string;
	/** Table the setup created under `[root, children[0]]`. */
	table: string;
	/** The table's columns as this kind renders them (types are kind-specific). */
	expectedColumns: TableColumn[];
	/** Rendered partition fields, when the kind and upstream support them. */
	expectedPartitioning?: string[];
}

export interface BrowseContractOptions<C> {
	browse: BrowseCapability<C>;
	config: C;
	probe: IntegrationProbe;
	/** Seeds the fixture on the upstream via its own client — never the probe under test. */
	setup(): Promise<BrowseContractFixture>;
	/** Best-effort removal of what `setup` created; failures never fail the suite. */
	teardown?(fixture: BrowseContractFixture): Promise<void>;
	/** Page size for every listing, small enough to exercise upstream pagination. */
	pageLimit?: number;
}

export function browseContract<C>(name: string, options: () => BrowseContractOptions<C>): void {
	describe(`Browse contract: ${name}`, () => {
		let opts: BrowseContractOptions<C>;
		let fixture: BrowseContractFixture;

		beforeAll(async () => {
			opts = options();
			fixture = await opts.setup();
			expect(fixture.children.length).toBeGreaterThanOrEqual(2);
		}, 30_000);

		afterAll(async () => {
			if (fixture) await opts.teardown?.(fixture)?.catch(() => {});
		});

		/**
		 * Follows cursors to exhaustion. Termination comes from PROGRESS, not a
		 * small page budget — a shared live catalog can legitimately hold hundreds
		 * of entries: a repeated cursor is a cycle, and the large ceiling is only a
		 * runaway backstop.
		 */
		const listAll = async <T>(
			load: (cursor: string | undefined) => Promise<{ items: T[]; next_cursor: string | null }>,
		): Promise<T[]> => {
			const items: T[] = [];
			const seen = new Set<string>();
			let cursor: string | undefined;
			for (let i = 0; i < 1000; i++) {
				const page = await load(cursor);
				items.push(...page.items);
				if (page.next_cursor === null) return items;
				if (seen.has(page.next_cursor)) {
					throw new Error('pagination cycled without terminating');
				}
				seen.add(page.next_cursor);
				cursor = page.next_cursor;
			}
			throw new Error('pagination did not terminate within 1000 pages');
		};

		const limit = () => opts.pageLimit ?? 2;

		it('lists the fixture root namespace, without leaking descendants', async () => {
			const roots = await listAll((cursor) =>
				opts.browse.listNamespaces(opts.config, opts.probe, { limit: limit(), cursor }),
			);
			// Everything under the fixture root — children AND the grandchild — must
			// collapse to exactly the root entry at this level.
			expect(roots.filter(([first]) => first === fixture.root)).toEqual([[fixture.root]]);
		});

		it('lists exactly the direct children under the root', async () => {
			const children = await listAll((cursor) =>
				opts.browse.listNamespaces(opts.config, opts.probe, {
					limit: limit(),
					cursor,
					parent: [fixture.root],
				}),
			);
			// Exact set: no parent echo, no grandchild leak, no unrelated entries.
			const key = (namespace: string[]) => namespace.join('\u001f');
			expect(children.map(key).sort()).toEqual(
				fixture.children.map((child) => key([fixture.root, child])).sort(),
			);
		});

		it('lists the grandchild one level down, not before', async () => {
			const grandchildren = await listAll((cursor) =>
				opts.browse.listNamespaces(opts.config, opts.probe, {
					limit: limit(),
					cursor,
					parent: [fixture.root, fixture.children[0]],
				}),
			);
			expect(grandchildren).toContainEqual([fixture.root, fixture.children[0], fixture.grandchild]);
		});

		it('lists the fixture table in its namespace', async () => {
			const tables = await listAll((cursor) =>
				opts.browse.listTables(opts.config, opts.probe, [fixture.root, fixture.children[0]], {
					limit: limit(),
					cursor,
				}),
			);
			expect(tables).toContain(fixture.table);
		});

		it('reads the table schema back', async () => {
			const schema = await opts.browse.getTableSchema(
				opts.config,
				opts.probe,
				[fixture.root, fixture.children[0]],
				fixture.table,
			);
			expect(schema.columns).toEqual(fixture.expectedColumns);
			if (fixture.expectedPartitioning) {
				expect(schema.partitioning).toEqual(fixture.expectedPartitioning);
			}
		});
	});
}

/**
 * A plain-`fetch` probe for live suites. The guarded probe adapter lives in
 * `@marimo-hub/config` and is not what a browse contract tests.
 */
export function fetchProbe(): IntegrationProbe {
	return {
		fetch: async (url, init) => {
			const res = await fetch(url, {
				method: init?.method ?? 'GET',
				headers: init?.headers,
				body: init?.body,
			});
			const text = await res.text();
			return {
				ok: res.ok,
				status: res.status,
				json: () => {
					try {
						return Promise.resolve(JSON.parse(text));
					} catch {
						return Promise.resolve(undefined);
					}
				},
			};
		},
	};
}
