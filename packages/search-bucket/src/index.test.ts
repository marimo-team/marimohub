import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createProjectId, createNotebookId } from '@marimo-hub/core/ids';
import type { SearchSnapshot } from '@marimo-hub/core/search/contracts';
import { searchPaths } from '@marimo-hub/core/search/paths';
import { searchIndexContract } from '@marimo-hub/core/testing/search';
import { BucketSearchIndex } from './index';
const signal = () => new AbortController().signal;
const scope = { projectId: createProjectId(), source: 'notebooks' };
function snapshot(count = 1): SearchSnapshot {
	return {
		schema_version: 1,
		indexed_at: new Date().toISOString(),
		partial: false,
		documents: Array.from({ length: count }, (_, i) => ({
			id: `doc-${i}`,
			kind: 'code',
			resource: { type: 'notebook', notebook_id: createNotebookId() },
			title: `Notebook ${i}`,
			text: `net_revenue metric${i}`,
			fingerprint: `${i}`,
		})),
	};
}
afterEach(() => vi.restoreAllMocks());
searchIndexContract('BucketSearchIndex', () => new BucketSearchIndex(new MemoryBucket()));
describe('bucket search index', () => {
	it('does not fence a head when cleanup has nothing expired to delete', async () => {
		const bucket = new MemoryBucket();
		const index = new BucketSearchIndex(bucket);
		await index.publish(scope, snapshot(), null, signal());
		const previous = await index.head(scope, signal());
		await index.publish(scope, snapshot(2), previous.revision, signal());
		const put = vi.spyOn(bucket, 'put');
		const remove = vi.spyOn(bucket, 'delete');
		await index.prune(scope, signal());
		expect(put).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});
	it('batches expired snapshot deletions behind one fence', async () => {
		const bucket = new MemoryBucket();
		const index = new BucketSearchIndex(bucket);
		for (let i = 0; i < 4; i++)
			await index.publish(
				scope,
				snapshot(i + 1),
				(await index.head(scope, signal())).revision,
				signal(),
			);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 24 * 3600_000);
		const put = vi.spyOn(bucket, 'put');
		const remove = vi.spyOn(bucket, 'delete');
		await index.prune(scope, signal());
		expect(put).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledOnce();
		expect(remove.mock.calls[0][0]).toHaveLength(3);
		expect((await index.read(scope, signal())).snapshot?.documents).toHaveLength(4);
	});
	it('does not delete after a publisher wins the cleanup fence race', async () => {
		const bucket = new MemoryBucket();
		const index = new BucketSearchIndex(bucket);
		await index.publish(scope, snapshot(), null, signal());
		await index.publish(scope, snapshot(2), (await index.head(scope, signal())).revision, signal());
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 24 * 3600_000);
		const list = bucket.list.bind(bucket);
		vi.spyOn(bucket, 'list').mockImplementationOnce(async (options) => {
			const result = await list(options);
			await index.publish(
				scope,
				snapshot(3),
				(await index.head(scope, signal())).revision,
				signal(),
			);
			return result;
		});
		const remove = vi.spyOn(bucket, 'delete');
		await index.prune(scope, signal());
		expect(remove).not.toHaveBeenCalled();
		expect((await index.read(scope, signal())).snapshot?.documents).toHaveLength(3);
	});
	it('rejects a head pointing outside its own project/source snapshot prefix', async () => {
		const bucket = new MemoryBucket();
		const index = new BucketSearchIndex(bucket);
		const headKey = `_system/search/projects/${scope.projectId}/${scope.source}/head.json`;
		await bucket.put(
			headKey,
			JSON.stringify({
				schema_version: 1,
				generation: crypto.randomUUID(),
				deleted: false,
				key: '_system/private.json',
			}),
		);
		const get = vi.spyOn(bucket, 'get');
		await expect(index.read(scope, signal())).rejects.toThrow('Invalid search snapshot path');
		expect(get.mock.calls).toEqual([[headKey]]);
	});
	it.each(['missing', 'malformed', 'oversized'] as const)(
		'fails closed for a %s published snapshot',
		async (failure) => {
			const bucket = new MemoryBucket();
			const index = new BucketSearchIndex(bucket);
			await index.publish(scope, snapshot(), null, signal());
			const snapshots = await bucket.list({
				prefix: `_system/search/projects/${scope.projectId}/${scope.source}/snapshots/`,
			});
			const key = snapshots.objects[0].key;
			if (failure === 'missing') await bucket.delete(key);
			else await bucket.put(key, failure === 'malformed' ? '{}' : 'x'.repeat(16 * 1024 * 1024 + 1));
			await expect(index.candidates(scope, { query: 'net_revenue' }, signal())).rejects.toThrow();
		},
	);
	it('does not fall back to cached content after a head read fails', async () => {
		const bucket = new MemoryBucket();
		const index = new BucketSearchIndex(bucket);
		await index.publish(scope, snapshot(), null, signal());
		await index.read(scope, signal());
		vi.spyOn(bucket, 'get').mockRejectedValueOnce(new Error('storage offline'));
		await expect(index.candidates(scope, { query: 'net_revenue' }, signal())).rejects.toThrow(
			'storage offline',
		);
	});
	it('uses an inverted index and reads only the head on warm queries', async () => {
		const bucket = new MemoryBucket();
		const index = new BucketSearchIndex(bucket);
		await index.publish(scope, snapshot(1000), null, signal());
		const get = vi.spyOn(bucket, 'get');
		const list = vi.spyOn(bucket, 'list');
		expect(
			(await index.candidates(scope, { query: 'metric999' }, signal())).documents.map((d) => d.id),
		).toEqual(['doc-999']);
		expect(get).toHaveBeenCalledTimes(2);
		get.mockClear();
		expect(
			(await index.candidates(scope, { query: 'metric777' }, signal())).documents.map((d) => d.id),
		).toEqual(['doc-777']);
		expect(get).toHaveBeenCalledTimes(1);
		expect(list).not.toHaveBeenCalled();
	});
	it('invalidates cached generations after publication and deletion', async () => {
		const bucket = new MemoryBucket();
		const a = new BucketSearchIndex(bucket);
		const b = new BucketSearchIndex(bucket);
		await a.publish(scope, snapshot(), null, signal());
		const old = await a.read(scope, signal());
		await b.publish(scope, null, old.revision, signal());
		expect((await a.candidates(scope, { query: 'net_revenue' }, signal())).documents).toEqual([]);
		expect(await a.publish(scope, snapshot(), old.revision, signal())).toBe(false);
		expect((await a.read(scope, signal())).revision).not.toBeNull();
	});
	it('evicts the least recently used snapshot within the byte budget', async () => {
		const bucket = new MemoryBucket();
		const data = snapshot();
		const weight = new TextEncoder().encode(JSON.stringify(data)).length * 4;
		const index = new BucketSearchIndex(bucket, weight * 2);
		const scopes = ['first', 'second', 'third'].map((source) => ({ ...scope, source }));
		for (const entry of scopes) await index.publish(entry, data, null, signal());
		await index.read(scopes[0], signal());
		await index.read(scopes[1], signal());
		await index.read(scopes[0], signal());
		await index.read(scopes[2], signal());
		const get = vi.spyOn(bucket, 'get');
		await index.read(scopes[0], signal());
		expect(get).toHaveBeenCalledTimes(1);
		get.mockClear();
		await index.read(scopes[1], signal());
		expect(get).toHaveBeenCalledTimes(2);
	});
	it('counts concurrent loads of the same generation only once', async () => {
		const bucket = new MemoryBucket();
		const data = snapshot();
		const weight = new TextEncoder().encode(JSON.stringify(data)).length * 4;
		const index = new BucketSearchIndex(bucket, weight * 2);
		const other = { ...scope, source: 'other' };
		await index.publish(scope, data, null, signal());
		await index.publish(other, data, null, signal());
		await Promise.all([index.read(scope, signal()), index.read(scope, signal())]);
		await index.read(other, signal());
		const get = vi.spyOn(bucket, 'get');
		await index.read(scope, signal());
		await index.read(other, signal());
		expect(get).toHaveBeenCalledTimes(2);
	});
	it('coalesces cold downloads and parsing while callers cancel independently', async () => {
		const bucket = new MemoryBucket();
		const index = new BucketSearchIndex(bucket);
		const data = snapshot();
		await index.publish(scope, data, null, signal());
		const get = bucket.get.bind(bucket);
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const json = vi.fn();
		const spy = vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			const body = await get(key);
			if (key.startsWith(searchPaths.scope(scope).snapshots)) {
				started.resolve();
				await gate.promise;
				return (
					body && {
						...body,
						json: <T>() => {
							json();
							return body.json<T>();
						},
					}
				);
			}
			return body;
		});
		const cancelled = new AbortController();
		const first = index.read(scope, cancelled.signal);
		const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
		const second = index.read(scope, signal());
		await started.promise;
		cancelled.abort();
		await rejected;
		gate.resolve();
		expect((await second).snapshot).toEqual(data);
		expect(
			spy.mock.calls.filter(([key]) => key.startsWith(searchPaths.scope(scope).snapshots)),
		).toHaveLength(1);
		expect(json).toHaveBeenCalledOnce();
	});
	it('bounds stalled distinct loads while allowing callers to join an existing load', async () => {
		const bucket = new MemoryBucket();
		const index = new BucketSearchIndex(bucket);
		const scopes = Array.from({ length: 65 }, (_, i) => ({ ...scope, source: String(i) }));
		for (const entry of scopes) await index.publish(entry, snapshot(), null, signal());
		const get = bucket.get.bind(bucket);
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		let loads = 0;
		vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			if (key.includes('/snapshots/')) {
				if (++loads === 64) started.resolve();
				await gate.promise;
			}
			return get(key);
		});
		const pending = scopes.slice(0, 64).map((entry) => index.read(entry, signal()));
		await started.promise;
		await expect(index.read(scopes[64], signal())).rejects.toThrow('loading capacity exceeded');
		const joined = index.read(scopes[0], signal());
		gate.resolve();
		await Promise.all([...pending, joined]);
		expect(loads).toBe(64);
		expect((await index.read(scopes[64], signal())).snapshot).not.toBeNull();
		expect(loads).toBe(65);
	});
	it('retries a shared failed download instead of caching its rejection', async () => {
		const bucket = new MemoryBucket();
		const index = new BucketSearchIndex(bucket);
		await index.publish(scope, snapshot(), null, signal());
		const get = bucket.get.bind(bucket);
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const spy = vi.spyOn(bucket, 'get').mockImplementation(async (key) => {
			if (key.startsWith(searchPaths.scope(scope).snapshots)) {
				started.resolve();
				await gate.promise;
				throw new Error('storage offline');
			}
			return get(key);
		});
		const requests = [index.read(scope, signal()), index.read(scope, signal())];
		const failures = requests.map((request) => expect(request).rejects.toThrow('storage offline'));
		await started.promise;
		gate.resolve();
		await Promise.all(failures);
		expect(
			spy.mock.calls.filter(([key]) => key.startsWith(searchPaths.scope(scope).snapshots)),
		).toHaveLength(1);
		spy.mockRestore();
		expect((await index.read(scope, signal())).snapshot).not.toBeNull();
	});
	it('serves snapshots larger than the cache without evicting cached entries', async () => {
		const bucket = new MemoryBucket();
		const data = snapshot();
		const weight = new TextEncoder().encode(JSON.stringify(data)).length * 4;
		const index = new BucketSearchIndex(bucket, weight);
		const other = { ...scope, source: 'larger' };
		await index.publish(scope, data, null, signal());
		await index.publish(other, snapshot(2), null, signal());
		await index.read(scope, signal());
		expect((await index.read(other, signal())).snapshot?.documents).toHaveLength(2);
		const get = vi.spyOn(bucket, 'get');
		await index.read(scope, signal());
		expect(get).toHaveBeenCalledTimes(1);
		get.mockClear();
		await index.read(other, signal());
		expect(get).toHaveBeenCalledTimes(2);
	});
	it('bounds candidate count and reports partial coverage', async () => {
		const index = new BucketSearchIndex(new MemoryBucket());
		await index.publish(scope, snapshot(201), null, signal());
		const result = await index.candidates(scope, { query: 'net_revenue' }, signal());
		expect(result.documents).toHaveLength(200);
		expect(result.partial).toBe(true);
	});
	it('never publishes after cancellation between payload and head writes', async () => {
		const bucket = new MemoryBucket();
		const index = new BucketSearchIndex(bucket);
		const controller = new AbortController();
		const put = bucket.put.bind(bucket);
		vi.spyOn(bucket, 'put').mockImplementation(async (...args) => {
			const result = await put(...args);
			controller.abort();
			return result;
		});
		await expect(index.publish(scope, snapshot(), null, controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect((await index.read(scope, signal())).snapshot).toBeNull();
	});
	it('keeps current snapshots and tombstones during garbage collection', async () => {
		const bucket = new MemoryBucket();
		const index = new BucketSearchIndex(bucket);
		await index.publish(scope, snapshot(), null, signal());
		const old = await index.read(scope, signal());
		await index.publish(scope, snapshot(2), old.revision, signal());
		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 24 * 3600_000);
		await index.prune(scope, signal());
		const listed = await bucket.list({
			prefix: `_system/search/projects/${scope.projectId}/notebooks/snapshots/`,
		});
		expect(listed.objects).toHaveLength(1);
		expect((await index.read(scope, signal())).snapshot?.documents).toHaveLength(2);
		expect(await index.publish(scope, snapshot(), old.revision, signal())).toBe(false);
		const current = await index.head(scope, signal());
		await index.publish(scope, null, current.revision, signal());
		await index.prune(scope, signal());
		expect(
			(await bucket.list({ prefix: searchPaths.scope(scope).snapshots })).objects,
		).toHaveLength(0);
		const tombstone = await index.head(scope, signal());
		expect(tombstone.deleted).toBe(true);
		expect(await bucket.head(searchPaths.scope(scope).head)).not.toBeNull();
		expect(await index.publish(scope, snapshot(), tombstone.revision, signal())).toBe(false);
	});
});

describe('search build fencing', () => {
	const build = { revision: 1, source_revision: 1, configuration: 'keyword' };
	it('claims and verifies with head-only reads', async () => {
		const bucket = new MemoryBucket();
		const index = new BucketSearchIndex(bucket);
		await index.publish(scope, snapshot(), null, signal());
		const get = vi.spyOn(bucket, 'get');
		const claimed = await index.claim(scope, build, signal());
		expect(await index.touch(scope, claimed!.revision!, signal())).toBe(true);
		expect(new Set(get.mock.calls.map(([key]) => key))).toEqual(
			new Set([searchPaths.scope(scope).head]),
		);
		expect(
			(await bucket.list({ prefix: searchPaths.scope(scope).snapshots })).objects,
		).toHaveLength(1);
	});
	it('admits one competing first claim', async () => {
		const index = new BucketSearchIndex(new MemoryBucket());
		const claims = await Promise.all([
			index.claim(scope, build, signal()),
			index.claim(scope, { ...build, source_revision: 2 }, signal()),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
	});
	it('rejects oversized UTF-8 build metadata without poisoning the current head', async () => {
		const index = new BucketSearchIndex(new MemoryBucket());
		const previous = await index.claim(scope, build, signal());
		await expect(
			index.claim(scope, { ...build, revision: 2, configuration: '界'.repeat(2048) }, signal()),
		).rejects.toThrow('head exceeds budget');
		expect(await index.head(scope, signal())).toEqual(previous);
	});
	it('filters incompatible semantic spaces before the candidate budget', async () => {
		const index = new BucketSearchIndex(new MemoryBucket());
		const data = snapshot(202);
		data.documents = data.documents.map((doc, i) => ({
			...doc,
			embedding: { space: i === 201 ? 'current' : 'old', vector: [1, 0] },
		}));
		await index.publish(scope, data, null, signal());
		const result = await index.candidates(
			scope,
			{ query: 'unmatched', embedding: { space: 'current', vector: [1, 0] } },
			signal(),
		);
		expect(result.documents.map((doc) => doc.id)).toEqual(['doc-201']);
		expect(result.partial).toBe(false);
		expect(
			(
				await index.candidates(
					scope,
					{ query: 'unmatched', embedding: { space: 'current', vector: [1] } },
					signal(),
				)
			).documents,
		).toEqual([]);
	});
	it('keeps the most similar embedded documents regardless of snapshot order', async () => {
		const index = new BucketSearchIndex(new MemoryBucket());
		const data = snapshot(250);
		data.documents = data.documents.map((doc, i) => ({
			...doc,
			embedding: { space: 'current', vector: i === 249 ? [1, 0] : [0.1, 1] },
		}));
		await index.publish(scope, data, null, signal());
		const result = await index.candidates(
			scope,
			{ query: 'unmatched', embedding: { space: 'current', vector: [1, 0] } },
			signal(),
		);
		expect(result.documents).toHaveLength(200);
		expect(result.documents[0].id).toBe('doc-249');
		expect(result.partial).toBe(false);
	});
});
