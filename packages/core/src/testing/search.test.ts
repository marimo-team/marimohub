import { describe, expect, it } from 'vitest';
import { createNotebookId, createProjectId } from '../ids';
import { MAX_INDEX_BYTES } from '../search/contracts';
import type { SearchBuild, SearchSnapshot } from '../search/contracts';
import { MemorySearchIndex } from './search';

const scope = { projectId: createProjectId(), source: 'notebooks' };
function snapshot(): SearchSnapshot {
	return {
		schema_version: 1,
		indexed_at: new Date().toISOString(),
		partial: false,
		documents: [
			{
				id: 'notebook',
				kind: 'notebook',
				resource: { type: 'notebook', notebook_id: createNotebookId() },
				title: 'Revenue',
				text: 'Revenue projections',
				fingerprint: '1',
			},
		],
	};
}

describe('memory search index', () => {
	it.each([false, true])(
		'admits one concurrent publication with existing head %j',
		async (existing) => {
			const index = new MemorySearchIndex();
			if (existing) await index.publish(scope, snapshot(), null);
			const { revision } = await index.head(scope);
			const first = snapshot();
			const second = { ...snapshot(), partial: true };
			const results = await Promise.all([
				index.publish(scope, first, revision),
				index.publish(scope, second, revision),
			]);
			expect(results.filter(Boolean)).toHaveLength(1);
			expect((await index.read(scope)).snapshot).toEqual(results[0] ? first : second);
		},
	);
	it('does not resurrect a deletion with its current revision', async () => {
		const index = new MemorySearchIndex();
		await index.publish(scope, null, null);
		const head = await index.head(scope);
		expect(await index.publish(scope, snapshot(), head.revision)).toBe(false);
		expect(
			await index.claim(scope, { revision: 2, source_revision: 1, configuration: '' }),
		).toBeNull();
		expect(await index.head(scope)).toEqual(head);
	});
	it('rejects malformed snapshots without changing the current publication', async () => {
		const index = new MemorySearchIndex();
		const current = snapshot();
		await index.publish(scope, current, null);
		const { revision } = await index.head(scope);
		await expect(
			index.publish(scope, { ...snapshot(), indexed_at: 'invalid' }, revision),
		).rejects.toThrow();
		expect((await index.read(scope)).snapshot).toEqual(current);
	});
	it('measures snapshot budget in UTF-8 bytes rather than code units', async () => {
		const index = new MemorySearchIndex();
		const data = snapshot();
		data.documents = Array.from({ length: 800 }, (_, i) => ({
			...data.documents[0],
			id: String(i),
			text: '界'.repeat(8192),
		}));
		const serialized = JSON.stringify(data);
		expect(serialized.length).toBeLessThan(MAX_INDEX_BYTES);
		expect(new TextEncoder().encode(serialized).length).toBeGreaterThan(MAX_INDEX_BYTES);
		await expect(index.publish(scope, data, null)).rejects.toThrow('snapshot exceeds budget');
		expect((await index.head(scope)).revision).toBeNull();
	});
	it.each([
		{ revision: 0, source_revision: 1, configuration: '' },
		{ revision: 1, source_revision: 0, configuration: '' },
		{ revision: 1, source_revision: 1, configuration: 'x'.repeat(2049) },
	])('rejects invalid builds %j', async (build: SearchBuild) => {
		const index = new MemorySearchIndex();
		await expect(index.claim(scope, build)).rejects.toThrow();
		expect((await index.head(scope)).revision).toBeNull();
	});
	it('copies build and snapshot inputs before retaining them', async () => {
		const index = new MemorySearchIndex();
		const build = { revision: 1, source_revision: 1, configuration: 'keyword' };
		const head = await index.claim(scope, build);
		const data = snapshot();
		await index.publish(scope, data, head!.revision);
		build.configuration = 'changed';
		data.documents[0].title = 'changed';
		expect((await index.head(scope)).build?.configuration).toBe('keyword');
		expect((await index.read(scope)).snapshot?.documents[0].title).toBe('Revenue');
	});
});
