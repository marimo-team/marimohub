import { afterEach, expect, it, vi } from 'vitest';
import { createSearchFixture, searchOwner } from '../testing/search';
import { paths } from '../paths';
import { createVersionId } from '../ids';
import { sha256Hex } from '../internal/sha256';
import { savedOutputText } from './NotebookSource';

afterEach(() => vi.restoreAllMocks());

async function setup() {
	const f = await createSearchFixture();
	const raw = paths.project(f.project.id).notebook(f.notebook.id);
	const stored = await f.services.notebooks.getNotebookSource(f.project.id, f.notebook.id);
	const keys = { ...raw, code: raw.version(stored.current_version_id!).code };
	const signal = new AbortController().signal;
	const scope = { projectId: f.project.id, source: f.source.id };
	return {
		...f,
		keys,
		signal,
		crawl: () => f.indexer.step(f.project.id, f.source, signal),
		snapshot: async () => (await f.index.read(scope)).snapshot!,
		page: () => f.source.page(f.project, undefined, signal),
		outputVersion: async () => {
			keys.code = raw.code;
			const version = createVersionId();
			await f.bucket.put(
				keys.source,
				JSON.stringify({ schema_version: 1, type: 'local', current_version_id: version }),
			);
			return keys.version(version);
		},
	};
}

it.each(['meta', 'source'] as const)(
	'reports missing required %s as partial coverage',
	async (kind) => {
		const f = await setup();
		await f.bucket.delete(f.keys[kind]);
		expect(await f.page()).toMatchObject({
			documents: [],
			partial: true,
		});
	},
);
it.each(['meta', 'source'] as const)(
	'reports oversized required %s as partial coverage',
	async (kind) => {
		const f = await setup();
		await f.bucket.put(f.keys[kind], ' '.repeat(2 * 1024 * 1024 + 1));
		expect(await f.page()).toMatchObject({
			documents: [],
			partial: true,
		});
	},
);
it('intentionally skips deleted notebooks even when their source has been removed', async () => {
	const f = await setup();
	const meta = await (await f.bucket.get(f.keys.meta))!.json<Record<string, unknown>>();
	await f.bucket.put(f.keys.meta, JSON.stringify({ ...meta, status: 'deleted' }));
	await f.bucket.delete(f.keys.source);
	expect(await f.page()).toMatchObject({
		documents: [],
		partial: false,
	});
});

it('rejects move-fenced notebooks even when the indexed fingerprint matches and recovers after unfencing', async () => {
	const f = await setup();
	const scope = { projectId: f.project.id, source: f.source.id };
	const meta = await (await f.bucket.get(f.keys.meta))!.json<Record<string, unknown>>();
	const fenced = await f.bucket.put(
		f.keys.meta,
		JSON.stringify({ ...meta, move_id: 'pending-move' }),
	);
	const source = await f.bucket.head(f.keys.source);
	const code = await f.bucket.head(f.keys.code);
	const snapshot = await f.snapshot();
	// An older crawler could have published documents while the metadata was fenced.
	const content = await sha256Hex(
		JSON.stringify([fenced.etag, source!.etag, code!.key, code!.etag, null, null]),
	);
	const { revision } = await f.index.head(scope);
	await f.index.publish(
		scope,
		{
			...snapshot,
			documents: snapshot.documents.map((document) => ({
				...document,
				fingerprint: `${content}:${snapshot.documents.length}:complete`,
			})),
		},
		revision,
	);
	const get = vi.spyOn(f.bucket, 'get');
	const head = vi.spyOn(f.bucket, 'head');
	const result = await f.search.search(searchOwner, f.query);
	expect(result.items).toEqual([]);
	expect(result.partial).toBe(true);
	expect(get.mock.calls.filter(([key]) => key === f.keys.meta)).toHaveLength(1);
	expect(head).not.toHaveBeenCalled();
	expect(await f.page()).toMatchObject({ documents: [], partial: true });
	await f.bucket.put(f.keys.meta, JSON.stringify(meta));
	await f.crawl();
	const recovered = await f.search.search(searchOwner, f.query);
	expect(recovered.items).toHaveLength(1);
	expect(recovered.partial).toBe(false);
});

it.each([false, true])(
	'reuses unchanged snapshot documents without downloading code or output (truncated: %s)',
	async (truncated) => {
		const f = await setup();
		const output = await f.outputVersion();
		await f.bucket.put(
			output.html,
			`<p>Revenue output</p>${truncated ? ' '.repeat(64 * 1024) : ''}`,
		);
		await f.crawl();
		expect((await f.snapshot()).partial).toBe(truncated);
		const get = vi.spyOn(f.bucket, 'get');
		await f.crawl();
		expect(get.mock.calls.some(([key]) => key === f.keys.code || key === output.html)).toBe(false);
		await f.bucket.put(f.keys.code, 'changed_revenue = 99');
		get.mockClear();
		await f.crawl();
		expect(get.mock.calls.some(([key]) => key === f.keys.code)).toBe(true);
		expect((await f.snapshot()).documents.map((doc) => doc.text)).toContain('changed_revenue = 99');
	},
);

it('retries missing artifacts from a partial snapshot even when their ETags are unchanged', async () => {
	const f = await setup();
	await f.bucket.put(f.keys.code, 'changed = 1');
	const get = f.bucket.get.bind(f.bucket);
	const spy = vi
		.spyOn(f.bucket, 'get')
		.mockImplementation((key, options) =>
			key === f.keys.code ? Promise.resolve(null) : get(key, options),
		);
	await f.crawl();
	expect((await f.snapshot()).partial).toBe(true);
	spy.mockRestore();
	await f.crawl();
	const snapshot = await f.snapshot();
	expect(snapshot.partial).toBe(false);
	expect(snapshot.documents.some((doc) => doc.kind === 'code')).toBe(true);
});

it('bounds HTML input before parsing and reports truncated coverage', async () => {
	const f = await setup();
	const output = await f.outputVersion();
	await f.bucket.put(output.html, `<p>visible</p>${' '.repeat(64 * 1024)}<p>outside budget</p>`);
	const page = await f.page();
	expect(page.partial).toBe(true);
	expect(page.documents.find((doc) => doc.kind === 'output')?.text).toBe('visible');
});

it('rebuilds a notebook group cut off by the snapshot document budget', async () => {
	const f = await setup();
	const snapshot = await f.snapshot();
	const get = vi.spyOn(f.bucket, 'get');
	const page = await f.source.page(f.project, undefined, f.signal, {
		...snapshot,
		partial: true,
		documents: snapshot.documents.slice(0, 1),
	});
	expect(get.mock.calls.some(([key]) => key === f.keys.code)).toBe(true);
	expect(page.documents).toEqual(snapshot.documents);
	expect(page.partial).toBe(false);
});

it('shares the HTML input budget across saved outputs', () => {
	const truncated = vi.fn();
	const text = savedOutputText(
		JSON.stringify({
			cells: [
				{
					outputs: [
						{ type: 'data', data: { 'text/html': `<p>visible</p>${' '.repeat(32 * 1024)}` } },
						{ type: 'data', data: { 'text/html': '<p>outside budget</p>' } },
					],
				},
			],
		}),
		truncated,
	);
	expect(text).toBe('visible');
	expect(truncated).toHaveBeenCalled();
});

it('does not probe HTML when a saved session exists', async () => {
	const f = await setup();
	const output = await f.outputVersion();
	await f.bucket.put(
		output.session,
		JSON.stringify({
			cells: [{ outputs: [{ type: 'data', data: { 'text/plain': 'saved output' } }] }],
		}),
	);
	const head = vi.spyOn(f.bucket, 'head');
	const page = await f.page();
	expect(page.documents.find((doc) => doc.kind === 'output')?.text).toBe('saved output');
	expect(head.mock.calls.some(([key]) => key === output.html)).toBe(false);
});

it('does not reuse content when the bucket cannot supply an ETag', async () => {
	const f = await setup();
	const head = f.bucket.head.bind(f.bucket);
	const get = f.bucket.get.bind(f.bucket);
	vi.spyOn(f.bucket, 'head').mockImplementation(async (key) => {
		const object = await head(key);
		return key === f.keys.code && object ? { ...object, etag: '' } : object;
	});
	const reads = vi.spyOn(f.bucket, 'get').mockImplementation(async (key, options) => {
		const object = await get(key, options);
		return key === f.keys.code && object ? { ...object, etag: '' } : object;
	});
	await f.crawl();
	await f.bucket.put(f.keys.code, 'changed_without_etag = 1');
	reads.mockClear();
	await f.crawl();
	expect(reads.mock.calls.some(([key]) => key === f.keys.code)).toBe(true);
	expect((await f.snapshot()).documents.map((doc) => doc.text)).toContain(
		'changed_without_etag = 1',
	);
});

it('retries a code read that changed between HEAD and GET', async () => {
	const f = await setup();
	await f.bucket.put(f.keys.code, 'before_race = 1');
	const get = f.bucket.get.bind(f.bucket);
	let raced = false;
	vi.spyOn(f.bucket, 'get').mockImplementation(async (key, options) => {
		if (key === f.keys.code && !raced) {
			raced = true;
			await f.bucket.put(key, 'after_race = 2');
		}
		return get(key, options);
	});
	await f.crawl();
	const racedSnapshot = await f.snapshot();
	expect(racedSnapshot.partial).toBe(true);
	expect(racedSnapshot.documents.some((doc) => doc.kind === 'code')).toBe(false);
	await f.crawl();
	const recovered = await f.snapshot();
	expect(recovered.partial).toBe(false);
	expect(recovered.documents.map((doc) => doc.text)).toContain('after_race = 2');
});

it('preserves code when saved output is malformed and recovers after it is repaired', async () => {
	const f = await setup();
	const output = await f.outputVersion();
	await f.bucket.put(output.session, '{broken');
	await f.crawl();
	const broken = await f.snapshot();
	expect(broken.partial).toBe(true);
	expect(broken.documents.map((doc) => doc.kind)).toEqual(['notebook', 'code']);
	await f.bucket.put(
		output.session,
		JSON.stringify({
			cells: [{ outputs: [{ type: 'data', data: { 'text/plain': 'recovered' } }] }],
		}),
	);
	await f.crawl();
	const recovered = await f.snapshot();
	expect(recovered.partial).toBe(false);
	expect(recovered.documents.find((doc) => doc.kind === 'output')?.text).toBe('recovered');
});
