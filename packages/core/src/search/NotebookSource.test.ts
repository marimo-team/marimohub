import { expect, it } from 'vitest';
import { createSearchFixture } from '../testing/search';
import { paths } from '../paths';

async function setup() {
	const f = await createSearchFixture();
	return { ...f, keys: paths.project(f.project.id).notebook(f.notebook.id) };
}

it.each(['meta', 'source'] as const)(
	'reports missing required %s as partial coverage',
	async (kind) => {
		const f = await setup();
		await f.bucket.delete(f.keys[kind]);
		expect(await f.source.page(f.project, undefined, new AbortController().signal)).toMatchObject({
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
		expect(await f.source.page(f.project, undefined, new AbortController().signal)).toMatchObject({
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
	expect(await f.source.page(f.project, undefined, new AbortController().signal)).toMatchObject({
		documents: [],
		partial: false,
	});
});
