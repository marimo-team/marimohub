import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { FsStorage } from '@marimo-hub/storage-fs';
import { createServices, createVersionId, paths, mapWithConcurrency } from '@marimo-hub/core';
import type { Bucket, AuthenticatedPrincipal } from '@marimo-hub/core';
import {
	makeProject,
	makeNotebookMeta,
	makeSnapshotNotebookEntry,
	makeSnapshotProjectEntry,
	ACTOR,
} from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { makeTestDeps } from '@marimo-hub/api/testing';
import { SearchRequestSchema } from '@marimo-hub/core/search';
import { makeSearch } from './search';

it.skipIf(process.env.SEARCH_BENCH !== '1')(
	'measures project search latency and storage operations',
	async () => {
		const directory = await mkdtemp(join(tmpdir(), 'marimohub-search-bench-'));
		const reports: unknown[] = [];
		try {
			for (const count of [1000, 5000]) {
				const storage = new FsStorage({ root: join(directory, String(count)) });
				let get = 0,
					head = 0,
					list = 0,
					bytes = 0;
				const bucket: Bucket = {
					get: async (key) => {
						get++;
						const body = await storage.get(key);
						bytes += body?.size ?? 0;
						return body;
					},
					head: async (key) => {
						head++;
						return storage.head(key);
					},
					list: async (options) => {
						list++;
						return storage.list(options);
					},
					put: storage.put.bind(storage),
					delete: storage.delete.bind(storage),
				};
				const services = createServices(bucket);
				await services.catalog.initialize(ACTOR);
				const project = makeProject({ name: 'Analytics' });
				await bucket.put(paths.project(project.id).meta, JSON.stringify(project));
				const notebooks = Array.from({ length: count }, (_, i) =>
					makeNotebookMeta({
						project_id: project.id,
						title: `Revenue model ${i}`,
						description: `Regional quarterly analysis cohort${i % 100}`,
					}),
				);
				await mapWithConcurrency(notebooks, 16, async (notebook, i) => {
					const nb = paths.project(project.id).notebook(notebook.id);
					const version = createVersionId();
					await bucket.put(nb.meta, JSON.stringify(notebook));
					await bucket.put(
						nb.source,
						JSON.stringify({ schema_version: 1, type: 'local', current_version_id: version }),
					);
					await bucket.put(
						nb.code,
						`import marimo\nimport pandas as pd\n# cohort${i % 100}\n${Array.from(
							{ length: 18 },
							(_, j) => `revenue_${j} = data.groupby("region").agg(total=("revenue", "sum"))`,
						).join('\n')}`,
					);
					if (i % 4 === 0)
						await bucket.put(
							nb.version(version).session,
							JSON.stringify({
								cells: [
									{
										outputs: [
											{
												type: 'data',
												data: {
													'text/plain': `Regional revenue cohort${i % 100}\n${'US 1000 EUR 800 APAC 1200\n'.repeat(
														12,
													)}`,
												},
											},
										],
									},
								],
							}),
						);
				});
				await services.catalog.mutateSnapshot('search-benchmark.seed', ACTOR, (s) => ({
					...s,
					projects: [
						makeSnapshotProjectEntry({
							...project,
							notebook_count: count,
							notebooks: notebooks.map((n) =>
								makeSnapshotNotebookEntry(project.id, { ...n, author: ACTOR }),
							),
						}),
					],
				}));
				const deps = makeTestDeps(new MemoryBucket(), { bucket, services });
				let search = makeSearch({ MARIMOHUB_SEARCH_BACKEND: 'bucket' }, deps)!;
				const start = performance.now();
				while (
					!(await search.indexer.step(
						project.id,
						search.service.sources[0],
						new AbortController().signal,
					))
				) {}
				const indexingMs = performance.now() - start;
				const principal: AuthenticatedPrincipal = {
					id: ACTOR,
					email: `${ACTOR}@example.com`,
					credential: { kind: 'development' },
				};
				for (const [name, q] of [
					['selective', 'cohort42'],
					['broad', 'revenue'],
				] as const) {
					const rows: {
						ms: number;
						get: number;
						head: number;
						list: number;
						bytes: number;
						hits: number;
						partial: boolean;
					}[] = [];
					// New services and a new adapter make the first run cold for both metadata and index caches.
					search = makeSearch(
						{ MARIMOHUB_SEARCH_BACKEND: 'bucket' },
						{ ...deps, services: createServices(bucket) },
					)!;
					for (let run = 0; run < 11; run++) {
						get = 0;
						head = 0;
						list = 0;
						bytes = 0;
						const t = performance.now();
						const result = await search.service.search(
							principal,
							SearchRequestSchema.parse({ q, project_id: project.id }),
						);
						rows.push({
							ms: performance.now() - t,
							get,
							head,
							list,
							bytes,
							hits: result.items.length,
							partial: result.partial,
						});
						expect(result.items.length).toBeGreaterThan(0);
					}
					const warm = rows.slice(1).sort((a, b) => a.ms - b.ms);
					reports.push({
						notebooks: count,
						query: name,
						indexingMs,
						cold: rows[0],
						warmMedian: { ...warm[4], ms: (warm[4].ms + warm[5].ms) / 2 },
						warmP95: warm[9],
						catalogProbes: 0,
					});
				}
			}
			const target = fileURLToPath(
				new URL('../../../.context/search-performance.json', import.meta.url),
			);
			await mkdir(new URL('../../../.context/', import.meta.url), { recursive: true });
			await writeFile(
				target,
				JSON.stringify(
					{
						node: process.version,
						platform: process.platform,
						storage: 'local filesystem',
						reports,
					},
					null,
					2,
				),
			);
			console.log(JSON.stringify(reports));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	180_000,
);
