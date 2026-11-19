import {
	ResourceExhaustedError,
	UnavailableError,
	ValidationError,
	withDeadline,
} from '@marimo-hub/core';
import * as browse from './browse';
import type { IntegrationBrowseContext } from './browse';
import { boundedData, DATA_MAX_BYTES, dataBytes } from './bounds';
export async function searchIntegrationTables(
	target: IntegrationBrowseContext,
	input: { q: string; namespace?: string[]; limit: number },
) {
	browse.requireDataBrowser(target.deps);
	const items: { integration_id: string; namespace: string[]; table: string }[] = [];
	let calls = 0;
	let scanned = 0;
	let reason: 'limit' | 'bytes' | 'budget' | 'cycle' | 'timeout' | null = null;
	const output = () => ({
		items,
		coverage: { complete: reason === null, reason },
		scanned_entries: scanned,
		browse_calls: calls,
	});
	const timeout = new UnavailableError('Table search timed out');
	try {
		await withDeadline(
			async (signal) => {
				// Authorize once; page loads then charge the separate `tableSearch`
				// budget so a cold search cannot exhaust the user's `browse` budget.
				const stateToken = await browse.authorizeCatalogBrowse({ ...target, signal });
				const active = {
					...target,
					signal,
					authorizedCatalog: { stateToken, budget: 'tableSearch' as const },
				};
				type Work = { kind: 'namespaces' | 'tables'; namespace?: string[]; cursor?: string };
				const queue: Work[] = input.namespace
					? [{ kind: 'tables', namespace: input.namespace }]
					: [{ kind: 'namespaces' }];
				const seen = new Set<string>();
				const namespaces = new Set<string>();
				const tables = new Set<string>();
				while (queue.length > 0) {
					signal.throwIfAborted();
					if (calls >= 32 || scanned >= 1000) {
						reason = 'budget';
						break;
					}
					const work = queue.shift()!;
					const workKey = JSON.stringify(work);
					if (seen.has(workKey)) {
						reason = 'cycle';
						break;
					}
					seen.add(workKey);
					calls++;
					if (work.kind === 'namespaces') {
						const page = await browse.listIntegrationNamespaces(active, {
							parent: work.namespace,
							cursor: work.cursor,
							limit: 20,
						});
						signal.throwIfAborted();
						for (const namespace of page.items) {
							if (scanned >= 1000) {
								reason = 'budget';
								break;
							}
							scanned++;
							const key = JSON.stringify(namespace);
							if (namespaces.has(key)) continue;
							namespaces.add(key);
							queue.push({ kind: 'tables', namespace }, { kind: 'namespaces', namespace });
						}
						if (page.next_cursor) queue.push({ ...work, cursor: page.next_cursor });
					} else {
						const namespace = work.namespace!;
						const page = await browse.listIntegrationTables(active, {
							namespace,
							cursor: work.cursor,
							limit: 100,
						});
						signal.throwIfAborted();
						for (const table of page.items) {
							if (scanned >= 1000) {
								reason = 'budget';
								break;
							}
							scanned++;
							const key = JSON.stringify([namespace, table]);
							if (tables.has(key)) continue;
							tables.add(key);
							if (!table.toLowerCase().includes(input.q.toLowerCase())) continue;
							if (items.length === input.limit) {
								reason = 'limit';
								break;
							}
							items.push({ integration_id: target.iid, namespace, table });
							if (dataBytes(output()) > DATA_MAX_BYTES - 256) {
								items.pop();
								reason = 'bytes';
								break;
							}
						}
						if (page.next_cursor) queue.push({ ...work, cursor: page.next_cursor });
					}
					if (reason) break;
				}
			},
			{
				timeoutMs: 6500,
				signal: target.signal,
				timeoutError: () => timeout,
			},
		);
	} catch (error) {
		target.signal?.throwIfAborted();
		if (error instanceof ResourceExhaustedError) reason = 'budget';
		else if (error === timeout) reason = 'timeout';
		else throw error;
	}
	return boundedData(output());
}

export async function profileIntegrationTable(
	target: IntegrationBrowseContext,
	input: { namespace: string[]; table: string; sample_rows: number; columns?: string[] },
) {
	const sample = await browse.previewIntegrationTable(target, {
		...input,
		limit: input.sample_rows,
	});
	target.signal?.throwIfAborted();
	const rows = sample.rows.slice(0, input.sample_rows);
	if (input.columns?.some((name) => !sample.columns.includes(name)))
		throw new ValidationError('A requested column is absent from the table preview.');
	const indices = sample.columns
		.map((name, index) => ({ name, index }))
		.filter(({ name }) => !input.columns || input.columns.includes(name));
	const columns = indices.slice(0, 50).map(({ name, index }) => {
		let nulls = 0;
		let unsupported = 0;
		const distinct = new Set<string>();
		for (const row of rows) {
			const value = row[index];
			if (value === null || value === undefined) nulls++;
			else if (
				typeof value === 'string' ||
				typeof value === 'boolean' ||
				(typeof value === 'number' && Number.isFinite(value))
			)
				distinct.add(JSON.stringify([typeof value, value]));
			else unsupported++;
		}
		return {
			name,
			null_count: nulls,
			non_null_count: rows.length - nulls,
			distinct_count: distinct.size,
			unsupported_count: unsupported,
		};
	});
	return boundedData({
		method: 'preview_sample' as const,
		rows_sampled: rows.length,
		sample_limit: input.sample_rows,
		truncated: indices.length > columns.length || sample.rows.length >= input.sample_rows,
		sampling: 'Provider preview order; not a random sample or whole-table estimate.' as const,
		columns,
	});
}
