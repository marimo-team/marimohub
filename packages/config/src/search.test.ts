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
	it('rejects orphan embedding keys when search is enabled', () => {
		expect(() =>
			makeSearch(
				{ MARIMOHUB_SEARCH_BACKEND: 'bucket', MARIMOHUB_SEARCH_EMBEDDING_API_KEY: 'secret' },
				deps(),
			),
		).toThrow('requires an embedding URL and model');
	});
	it.each([undefined, 'off'])('skips embedding validation with backend %j', (backend) => {
		expect(
			makeSearch(
				{
					MARIMOHUB_SEARCH_BACKEND: backend,
					MARIMOHUB_SEARCH_EMBEDDING_API_KEY: 'secret',
					MARIMOHUB_SEARCH_EMBEDDING_URL: 'not a url',
				},
				deps(),
			),
		).toBeUndefined();
	});
	it.each(['not a url', 'ftp://embedding.example/v1', 'https://user:pass@embedding.example/v1'])(
		'reports an invalid embedding URL %j as a configuration error',
		(url) => {
			expect(() =>
				makeSearch(
					{
						MARIMOHUB_SEARCH_BACKEND: 'bucket',
						MARIMOHUB_SEARCH_EMBEDDING_URL: url,
						MARIMOHUB_SEARCH_EMBEDDING_MODEL: 'model',
					},
					deps(),
				),
			).toThrow(
				expect.objectContaining({
					name: 'ConfigError',
					message: 'Invalid embedding endpoint',
					opts: { variable: 'MARIMOHUB_SEARCH_EMBEDDING_URL' },
				}),
			);
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
	it('reports an oversized embedding identity without blaming the URL alone', () => {
		expect(() =>
			makeSearch(
				{
					MARIMOHUB_SEARCH_BACKEND: 'bucket',
					MARIMOHUB_SEARCH_EMBEDDING_URL: 'https://embedding.example/v1/embeddings',
					MARIMOHUB_SEARCH_EMBEDDING_MODEL: 'm'.repeat(512),
				},
				deps(),
			),
		).toThrow(
			expect.objectContaining({
				name: 'ConfigError',
				message: expect.stringContaining('MARIMOHUB_SEARCH_EMBEDDING_MODEL'),
				opts: {},
			}),
		);
	});
	it('enables keyword search without embedding credentials', () => {
		expect(
			makeSearch({ MARIMOHUB_SEARCH_BACKEND: 'bucket' }, deps())?.service.sources.map((s) => s.id),
		).toEqual(['notebooks']);
	});
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
