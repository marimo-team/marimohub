import { describe, expect, it } from 'vitest';
import { makeTestDeps } from '@marimo-hub/api/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { makeSearch } from './search';

describe('search configuration', () => {
	const deps = () => makeTestDeps(new MemoryBucket());
	it('is disabled by default and rejects unknown backends', () => {
		expect(makeSearch({}, deps())).toBeUndefined();
		expect(() => makeSearch({ MARIMOHUB_SEARCH_BACKEND: 'unknown' }, deps())).toThrow(
			'off or bucket',
		);
	});
	it('enables keyword search without embedding credentials', () => {
		expect(
			makeSearch({ MARIMOHUB_SEARCH_BACKEND: 'bucket' }, deps())?.service.sources.map((s) => s.id),
		).toEqual(['notebooks']);
	});
	it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', ''])(
		'rejects invalid build revision %s',
		(revision) => {
			expect(() =>
				makeSearch(
					{ MARIMOHUB_SEARCH_BACKEND: 'bucket', MARIMOHUB_SEARCH_BUILD_REVISION: revision },
					deps(),
				),
			).toThrow('positive safe integer');
		},
	);
	it('requires both endpoint and model for semantic indexing', () => {
		expect(() =>
			makeSearch(
				{
					MARIMOHUB_SEARCH_BACKEND: 'bucket',
					MARIMOHUB_SEARCH_EMBEDDING_URL: 'https://embedding.example/v1/embeddings',
				},
				deps(),
			),
		).toThrow('together');
		expect(() =>
			makeSearch(
				{ MARIMOHUB_SEARCH_BACKEND: 'bucket', MARIMOHUB_SEARCH_EMBEDDING_MODEL: 'test' },
				deps(),
			),
		).toThrow('together');
	});
});
