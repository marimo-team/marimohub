import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { PreconditionFailedError } from '@marimo-hub/core';
import { bucketContract } from '@marimo-hub/core/testing/contract';
import { FsStorage } from './index';

const tmpRoots: string[] = [];
afterAll(() => {
	for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), 'marimohub-fs-'));
	tmpRoots.push(root);
	return root;
}

bucketContract('FsStorage', () => new FsStorage({ root: makeRoot() }));

describe('FsStorage', () => {
	describe('key validation / path traversal', () => {
		const badKeys = [
			'',
			'.',
			'..',
			'../escape',
			'a/../../escape',
			'a/..',
			'a/./b',
			'/etc/passwd',
			'a\0b',
			'a\\b',
			'a//b',
			'.tmp/x',
		];

		it.each(badKeys)('rejects %j on every operation', async (key) => {
			const bucket = new FsStorage({ root: makeRoot() });
			await expect(bucket.get(key)).rejects.toThrow(/Invalid bucket key|non-empty/);
			await expect(bucket.head(key)).rejects.toThrow(/Invalid bucket key|non-empty/);
			await expect(bucket.put(key, 'x')).rejects.toThrow(/Invalid bucket key|non-empty/);
			await expect(bucket.delete(key)).rejects.toThrow(/Invalid bucket key|non-empty/);
		});

		it('never touches files outside the root', async () => {
			const parent = makeRoot();
			const root = path.join(parent, 'store');
			const sentinel = path.join(parent, 'sentinel.txt');
			writeFileSync(sentinel, 'untouched');

			const bucket = new FsStorage({ root });
			await expect(bucket.put('../sentinel.txt', 'clobbered')).rejects.toThrow();
			await expect(bucket.get('../sentinel.txt')).rejects.toThrow();
			await expect(bucket.delete('../sentinel.txt')).rejects.toThrow();
			expect(readFileSync(sentinel, 'utf8')).toBe('untouched');
		});
	});

	describe('symlinks', () => {
		it('does not read or list through a symlink pointing outside the root', async () => {
			const parent = makeRoot();
			const root = path.join(parent, 'store');
			const secret = path.join(parent, 'secret.txt');
			writeFileSync(secret, 'secret');

			const bucket = new FsStorage({ root });
			symlinkSync(secret, path.join(root, 'link'));

			expect(await bucket.get('link')).toBeNull();
			expect(await bucket.head('link')).toBeNull();
			const listed = await bucket.list();
			expect(listed.objects.map((o) => o.key)).toEqual([]);
		});

		it('put replaces a symlink instead of writing through it', async () => {
			const parent = makeRoot();
			const root = path.join(parent, 'store');
			const target = path.join(parent, 'target.txt');
			writeFileSync(target, 'original');

			const bucket = new FsStorage({ root });
			symlinkSync(target, path.join(root, 'link'));

			await bucket.put('link', 'replaced');
			expect(readFileSync(target, 'utf8')).toBe('original');
			expect(await (await bucket.get('link'))!.text()).toBe('replaced');
		});
	});

	describe('etag stability across instances', () => {
		it('etags survive a new instance on the same root and support CAS', async () => {
			const root = makeRoot();
			const a = new FsStorage({ root });
			const put = await a.put('proj/n.json', '{"v":1}');

			const b = new FsStorage({ root });
			const head = await b.head('proj/n.json');
			expect(head!.etag).toBe(put.etag);

			const updated = await b.put('proj/n.json', '{"v":2}', { onlyIfEtagMatches: put.etag });
			expect(updated.etag).not.toBe(put.etag);
			await expect(
				b.put('proj/n.json', '{"v":3}', { onlyIfEtagMatches: put.etag }),
			).rejects.toBeInstanceOf(PreconditionFailedError);
		});

		it('CAS race across two instances in one process has exactly one winner', async () => {
			const root = makeRoot();
			const a = new FsStorage({ root });
			const b = new FsStorage({ root });
			const seed = await a.put('shared.json', '0');

			const results = await Promise.allSettled(
				Array.from({ length: 10 }, (_, i) =>
					(i % 2 === 0 ? a : b).put('shared.json', String(i + 1), {
						onlyIfEtagMatches: seed.etag,
					}),
				),
			);
			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
			for (const r of results) {
				if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(PreconditionFailedError);
			}
		});

		it('onlyIfEtagMatches with an empty etag never writes unconditionally', async () => {
			const bucket = new FsStorage({ root: makeRoot() });
			await bucket.put('guarded.json', 'original');
			await expect(
				bucket.put('guarded.json', 'clobbered', { onlyIfEtagMatches: '' }),
			).rejects.toBeInstanceOf(PreconditionFailedError);
			expect(await (await bucket.get('guarded.json'))!.text()).toBe('original');
		});

		it('onlyIfNotExists loses across two instances sharing a root', async () => {
			const root = makeRoot();
			const a = new FsStorage({ root });
			const b = new FsStorage({ root });

			await a.put('once.txt', 'first', { onlyIfNotExists: true });
			await expect(b.put('once.txt', 'second', { onlyIfNotExists: true })).rejects.toBeInstanceOf(
				PreconditionFailedError,
			);
			expect(await (await a.get('once.txt'))!.text()).toBe('first');
		});
	});

	describe('list semantics', () => {
		async function seeded(): Promise<FsStorage> {
			const bucket = new FsStorage({ root: makeRoot() });
			await bucket.put('a/1.json', '{}');
			await bucket.put('a/2.json', '{}');
			await bucket.put('a/sub/3.json', '{}');
			await bucket.put('b/4.json', '{}');
			return bucket;
		}

		it('lists all objects sorted without options', async () => {
			const result = await (await seeded()).list();
			expect(result.objects.map((o) => o.key)).toEqual([
				'a/1.json',
				'a/2.json',
				'a/sub/3.json',
				'b/4.json',
			]);
		});

		it('uses delimiter to group prefixes', async () => {
			const result = await (await seeded()).list({ prefix: 'a/', delimiter: '/' });
			expect(result.objects.map((o) => o.key)).toEqual(['a/1.json', 'a/2.json']);
			expect(result.delimitedPrefixes).toEqual(['a/sub/']);
		});

		it('prefix matches on string, not directory, boundaries', async () => {
			const bucket = new FsStorage({ root: makeRoot() });
			await bucket.put('p/1', 'a');
			await bucket.put('projects/x', 'b');
			const result = await bucket.list({ prefix: 'p' });
			expect(result.objects.map((o) => o.key)).toEqual(['p/1', 'projects/x']);
		});

		it('respects limit with truncated + cursor resume', async () => {
			const bucket = await seeded();
			const page1 = await bucket.list({ limit: 3 });
			expect(page1.objects.map((o) => o.key)).toEqual(['a/1.json', 'a/2.json', 'a/sub/3.json']);
			expect(page1.truncated).toBe(true);
			expect(page1.cursor).toBe('a/sub/3.json');

			const page2 = await bucket.list({ limit: 3, cursor: page1.cursor });
			expect(page2.objects.map((o) => o.key)).toEqual(['b/4.json']);
			expect(page2.truncated).toBe(false);
			expect(page2.cursor).toBeUndefined();
		});

		it('startAfter is an exclusive lower bound; the larger of cursor/startAfter wins', async () => {
			const bucket = await seeded();
			const result = await bucket.list({ startAfter: 'a/2.json' });
			expect(result.objects.map((o) => o.key)).toEqual(['a/sub/3.json', 'b/4.json']);

			const both = await bucket.list({ startAfter: 'a/1.json', cursor: 'a/sub/3.json' });
			expect(both.objects.map((o) => o.key)).toEqual(['b/4.json']);
		});

		it('delimited listings are returned whole regardless of limit', async () => {
			const bucket = new FsStorage({ root: makeRoot() });
			for (let i = 0; i < 5; i++) await bucket.put(`p/${i}/data`, '{}');
			const result = await bucket.list({ prefix: 'p/', delimiter: '/', limit: 2 });
			expect(result.truncated).toBe(false);
			expect(result.delimitedPrefixes).toHaveLength(5);
		});
	});

	describe('delete', () => {
		it('accepts an array and ignores missing keys', async () => {
			const bucket = new FsStorage({ root: makeRoot() });
			await bucket.put('x/1', 'a');
			await bucket.put('x/2', 'b');
			await bucket.delete(['x/1', 'x/2', 'x/missing']);
			expect((await bucket.list()).objects).toEqual([]);
		});

		it('prunes now-empty parent directories but keeps the root and non-empty dirs', async () => {
			const root = makeRoot();
			const bucket = new FsStorage({ root });
			await bucket.put('deep/nested/dir/file.txt', 'x');
			await bucket.put('deep/other.txt', 'y');

			await bucket.delete('deep/nested/dir/file.txt');
			expect(existsSync(path.join(root, 'deep/nested'))).toBe(false);
			expect(existsSync(path.join(root, 'deep/other.txt'))).toBe(true);

			await bucket.delete('deep/other.txt');
			expect(existsSync(path.join(root, 'deep'))).toBe(false);
			expect(existsSync(root)).toBe(true);
		});
	});

	describe('hygiene', () => {
		it('never lists entries under the .tmp staging dir', async () => {
			const root = makeRoot();
			const bucket = new FsStorage({ root });
			writeFileSync(path.join(root, '.tmp', 'stray'), 'leftover');
			await bucket.put('real.txt', 'x');
			expect((await bucket.list()).objects.map((o) => o.key)).toEqual(['real.txt']);
		});

		it('leaves no staged files behind after puts', async () => {
			const root = makeRoot();
			const bucket = new FsStorage({ root });
			await bucket.put('a.txt', '1');
			await bucket.put('a.txt', '2', { onlyIfEtagMatches: (await bucket.head('a.txt'))!.etag });
			await expect(bucket.put('a.txt', '3', { onlyIfNotExists: true })).rejects.toThrow();
			expect(await fsp.readdir(path.join(root, '.tmp'))).toEqual([]);
		});

		it('verifyConditionalWrites resolves and leaves no probe object', async () => {
			const bucket = new FsStorage({ root: makeRoot() });
			await bucket.verifyConditionalWrites();
			expect((await bucket.list()).objects).toEqual([]);
		});
	});
});
