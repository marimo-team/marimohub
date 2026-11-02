import { describe, expect, it } from 'vitest';
import { makeTestDeps } from '@marimo-hub/api/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { makeSearch } from './search';

describe('search configuration', () => {
	const deps = () => makeTestDeps(new MemoryBucket());
	it('is disabled by default and rejects unknown backends', () => {
		expect(makeSearch({}, deps())).toBeUndefined();
		expect(() => makeSearch({ MARIMOHUB_SEARCH_BACKEND: 'unknown' }, deps())).toThrow(
			'expected off, bucket',
		);
	});
	it.each(['BUCKET', ' bucket ', 'BuCkEt'])('normalizes backend %j', (backend) => {
		expect(makeSearch({ MARIMOHUB_SEARCH_BACKEND: backend }, deps())).toBeDefined();
	});
	it.each(['OFF', ' off ', '   ', ''])('disables backend %j', (backend) => {
		expect(makeSearch({ MARIMOHUB_SEARCH_BACKEND: backend }, deps())).toBeUndefined();
	});
	it.each([undefined, 'off', 'bucket'])(
		'rejects orphan embedding keys with backend %j',
		(backend) => {
			expect(() =>
				makeSearch(
					{ MARIMOHUB_SEARCH_BACKEND: backend, MARIMOHUB_SEARCH_EMBEDDING_API_KEY: 'secret' },
					deps(),
				),
			).toThrow('requires an embedding URL and model');
		},
	);
	it('rejects an HTTP embedding endpoint with a credential', () => {
		expect(() =>
			makeSearch(
				{
					MARIMOHUB_SEARCH_BACKEND: 'bucket',
					MARIMOHUB_SEARCH_EMBEDDING_URL: 'http://embedding.example/v1/embeddings',
					MARIMOHUB_SEARCH_EMBEDDING_MODEL: 'model',
					MARIMOHUB_SEARCH_EMBEDDING_API_KEY: 'secret',
				},
				deps(),
			),
		).toThrow('must use HTTPS');
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
