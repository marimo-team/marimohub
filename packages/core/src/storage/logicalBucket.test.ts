import { describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '../testing/MemoryBucket';
import { bucketStorage } from '../ports/metadata';
import { createLogicalStorage } from './logicalBucket';

function fixture(namespace = 'test', epoch = 1) {
	const raw = new MemoryBucket();
	const metadata = new MemoryBucket();
	return { raw, ...createLogicalStorage(raw, metadata, { namespace, epoch }) };
}
const metaKey = 'projects/p/notebooks/n/meta.json';
const artifactKey = 'projects/p/notebooks/n/workspace/data.json';

describe('logical storage', () => {
	it('preserves bucket-only identity and arbitrary keys', async () => {
		const bucket = new MemoryBucket();
		const storage = bucketStorage(bucket);
		expect(storage.logicalBucket).toBe(bucket);
		expect(storage.metadata).toBe(bucket);
		expect(storage.artifacts).toBe(bucket);
		await storage.logicalBucket.put('external', 'ok');
	});

	it('does not read legacy metadata or fall back after deletion', async () => {
		const { raw, metadata, logicalBucket, artifacts } = fixture();
		await raw.put(metaKey, 'stale');
		await logicalBucket.put(metaKey, 'current');
		await logicalBucket.put(artifactKey, 'payload');
		expect(await (await metadata.get(metaKey))!.text()).toBe('current');
		expect(await (await raw.get(artifactKey))!.text()).toBe('payload');
		await logicalBucket.delete(metaKey);
		expect(await logicalBucket.get(metaKey)).toBeNull();
		expect(() => artifacts.get(metaKey)).toThrow();
		expect(() => logicalBucket.get('_system/metadata-backend.json')).toThrow();
	});

	it('retains CAS and conditional GET semantics', async () => {
		const { logicalBucket } = fixture();
		const written = await logicalBucket.put(metaKey, 'one', { onlyIfNotExists: true });
		expect(await logicalBucket.get(metaKey, { ifNoneMatch: written.etag })).toMatchObject({
			notModified: true,
		});
		await logicalBucket.put(metaKey, 'two', { onlyIfEtagMatches: written.etag });
		await expect(
			logicalBucket.put(metaKey, 'three', { onlyIfEtagMatches: written.etag }),
		).rejects.toThrow();
	});

	it('merges more than a source page without omissions or legacy duplicates', async () => {
		const { raw, logicalBucket } = fixture();
		const expected = [];
		for (let i = 0; i < 1005; i++) {
			const prefix = `projects/${String(i).padStart(4, '0')}/`;
			for (const suffix of ['project.json', 'notebooks/n/workspace/file']) {
				const key = prefix + suffix;
				await logicalBucket.put(key, 'x');
				expected.push(key);
			}
			await raw.put(`${prefix}project.json`, 'stale');
		}
		await raw.put('_system/metadata-backend.json', 'control');
		const actual = [];
		let cursor: string | undefined;
		do {
			const page = await logicalBucket.list({ limit: 37, cursor });
			actual.push(...page.objects.map((object) => object.key));
			cursor = page.cursor;
		} while (cursor);
		expect(actual).toEqual(expected.sort());
	});

	it.each([10, 2000])(
		'passes bounded delimiter listing to each backend (limit %s)',
		async (limit) => {
			const { raw, metadata, logicalBucket } = fixture();
			await raw.put('projects/p/notebooks/n/workspace/folder/deep/file', 'x');
			await metadata.put(metaKey, '{}');
			const rawList = vi.spyOn(raw, 'list');
			const metaList = vi.spyOn(metadata, 'list');
			const result = await logicalBucket.list({
				prefix: 'projects/p/notebooks/n/',
				delimiter: '/',
				limit,
			});
			expect(result.delimitedPrefixes).toEqual(['projects/p/notebooks/n/workspace/']);
			expect(result.objects.map((object) => object.key)).toEqual([metaKey]);
			for (const spy of [rawList, metaList]) {
				expect(spy).toHaveBeenCalledOnce();
				expect(spy).toHaveBeenCalledWith(
					expect.objectContaining({ delimiter: '/', limit: Math.min(limit, 1000) }),
				);
			}
		},
	);
	it('deduplicates delimiter prefixes across stores and page boundaries', async () => {
		const { logicalBucket } = fixture();
		await logicalBucket.put(metaKey, 'x');
		await logicalBucket.put(artifactKey, 'x');
		await logicalBucket.put('projects/q/project.json', 'x');
		const first = await logicalBucket.list({ prefix: 'projects/', delimiter: '/', limit: 1 });
		expect(first.delimitedPrefixes).toEqual(['projects/p/']);
		const last = await logicalBucket.list({
			prefix: 'projects/',
			delimiter: '/',
			limit: 1,
			cursor: first.cursor,
		});
		expect(last.delimitedPrefixes).toEqual(['projects/q/']);
		expect(last.truncated).toBe(false);
	});

	it('round-trips Unicode cursors and rejects changed query or epoch', async () => {
		const { raw, metadata, logicalBucket } = fixture('部署');
		await logicalBucket.put('projects/é/project.json', 'x');
		await logicalBucket.put('projects/龍/project.json', 'x');
		const first = await logicalBucket.list({ limit: 1 });
		expect((await logicalBucket.list({ cursor: first.cursor })).objects).toHaveLength(1);
		await expect(logicalBucket.list({ cursor: first.cursor, delimiter: '/' })).rejects.toThrow(
			'cursor',
		);
		const other = createLogicalStorage(raw, metadata, { namespace: '部署', epoch: 2 });
		await expect(other.logicalBucket.list({ cursor: first.cursor })).rejects.toThrow('cursor');
	});

	it('preserves streaming and multipart capabilities only for artifacts', async () => {
		const raw = new MemoryBucket();
		const putStream = vi.fn(async (key: string) => raw.put(key, 'stream'));
		const multipart = {
			isolatedSessions: true as const,
			create: vi.fn(async () => ({ uploadId: 'upload' })),
			putPart: vi.fn(async () => ({ partNumber: 1, etag: 'part' })),
			complete: vi.fn(async () => raw.put(artifactKey, 'parts')),
			abort: vi.fn(async () => {}),
		};
		const source = Object.assign(raw, { putStream, multipart });
		const { logicalBucket } = createLogicalStorage(source, new MemoryBucket(), {
			namespace: 'test',
			epoch: 1,
		});
		async function* chunks() {
			yield new Uint8Array([1]);
		}
		await logicalBucket.putStream!(artifactKey, chunks(), 1);
		expect(putStream).toHaveBeenCalledOnce();
		expect(() => logicalBucket.putStream!(metaKey, chunks(), 1)).toThrow();
		expect(logicalBucket.multipart!.isolatedSessions).toBe(true);
		await logicalBucket.multipart!.create(artifactKey);
		await logicalBucket.multipart!.putPart(artifactKey, 'upload', 1, new Uint8Array([1]));
		await logicalBucket.multipart!.complete(artifactKey, 'upload', []);
		await logicalBucket.multipart!.abort(artifactKey, 'upload');
		expect(() => logicalBucket.multipart!.create(metaKey)).toThrow();
		expect(() =>
			logicalBucket.multipart!.putPart(metaKey, 'upload', 1, new Uint8Array()),
		).toThrow();
		expect(() => logicalBucket.multipart!.complete(metaKey, 'upload', [])).toThrow();
		expect(() => logicalBucket.multipart!.abort(metaKey, 'upload')).toThrow();
		expect(multipart.create).toHaveBeenCalledOnce();
		expect(multipart.putPart).toHaveBeenCalledOnce();
		expect(multipart.complete).toHaveBeenCalledOnce();
		expect(multipart.abort).toHaveBeenCalledOnce();
	});

	it('can retry a partially completed mixed delete', async () => {
		const { raw, logicalBucket } = fixture();
		await logicalBucket.put(metaKey, 'x');
		await logicalBucket.put(artifactKey, 'x');
		vi.spyOn(raw, 'delete').mockRejectedValueOnce(new Error('unavailable'));
		await expect(logicalBucket.delete([metaKey, artifactKey])).rejects.toThrow();
		await logicalBucket.delete([metaKey, artifactKey]);
		expect((await logicalBucket.list()).objects).toEqual([]);
	});
});
