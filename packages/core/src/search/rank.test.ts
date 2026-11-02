import { describe, expect, it } from 'vitest';
import { createNotebookId, createIntegrationId } from '../ids';
import type { SearchDocument } from './contracts';
import { terms } from './contracts';
import { rank, resourceHref, snippet } from './rank';

const notebook = { type: 'notebook' as const, notebook_id: createNotebookId() };
const integration = {
	type: 'integration' as const,
	integration_id: createIntegrationId(),
	version: 1,
};
const corpus: SearchDocument[] = [
	{
		id: 'annual',
		kind: 'notebook',
		resource: notebook,
		title: 'Annual revenue',
		text: 'Revenue and profit by region',
		fingerprint: '1',
	},
	{
		id: 'code',
		kind: 'code',
		resource: notebook,
		title: 'Forecast',
		text: 'net_revenue = revenue - refunds',
		fingerprint: '1',
	},
	{
		id: 'table',
		kind: 'table',
		resource: integration,
		title: 'Revenue',
		text: 'warehouse sales revenue',
		fingerprint: '1',
	},
	{
		id: 'output',
		kind: 'output',
		resource: notebook,
		title: 'Quarterly report',
		text: '季度收入 1000',
		fingerprint: '1',
	},
	{
		id: 'semantic',
		kind: 'notebook',
		resource: notebook,
		title: 'Sales outlook',
		text: 'Expected turnover',
		fingerprint: '1',
		embedding: { space: 'model-v1', vector: [1, 0] },
	},
];

describe('search relevance regression corpus', () => {
	it.each([
		{ query: 'annual revenue', expected: ['annual', 'table', 'code'] },
		{ query: 'warehouse', expected: ['table'] },
		{ query: 'net_revenue', expected: ['code'] },
		{ query: '季度收入', expected: ['output'] },
		{ query: 'reven', expected: [] },
		{ query: 'nonexistent', expected: [] },
	])('orders authorized mixed-kind candidates for "$query"', ({ query, expected }) => {
		expect(rank(corpus, query).map((row) => row.document.id)).toEqual(expected);
	});
	it('uses only compatible vectors for semantic-only matches', () => {
		expect(
			rank(corpus, 'forecasting', { space: 'model-v1', vector: [1, 0] }).map(
				(row) => row.document.id,
			),
		).toEqual(['semantic']);
		expect(rank(corpus, 'forecasting', { space: 'model-v2', vector: [1, 0] })).toEqual([]);
		expect(rank(corpus, 'forecasting', { space: 'model-v1', vector: [1] })).toEqual([]);
	});
	it('documents that local first-place scores are not calibrated across projects', () => {
		const strong = rank([corpus[0]], 'annual revenue')[0];
		const weak = rank([corpus[1]], 'annual revenue')[0];
		expect(strong.lexical).toBeGreaterThan(weak.lexical);
		expect(strong.score).toBe(weak.score);
	});
	it('breaks ties consistently without depending on candidate arrival order', () => {
		const tied = ['z', 'a'].map((id) => ({ ...corpus[0], id }));
		expect(rank(tied, 'revenue')).toEqual(rank([...tied].reverse(), 'revenue'));
	});
});

describe('search destinations', () => {
	it.each(['namespace', 'table', 'column'] as const)(
		'preserves the data-browser destination for %s',
		(kind) => {
			const ref = {
				...integration,
				namespace: ['sales & growth', '季度'],
				...(kind !== 'namespace' ? { table: 'order/items' } : {}),
				...(kind === 'column' ? { column: 'total' } : {}),
			};
			const href = resourceHref('project/name', { ...corpus[2], kind, resource: ref });
			const url = new URL(href, 'https://example.com');
			expect(url.pathname).toBe(`/projects/project%2Fname/data/${integration.integration_id}`);
			expect(url.searchParams.get('ns')).toBe(ref.namespace.join('\u001f'));
			expect(url.searchParams.get('table')).toBe(ref.table ?? null);
		},
	);
});

describe('search snippets', () => {
	it('keeps word boundaries and query offsets inside a bounded excerpt', () => {
		const result = snippet(`${'prefix '.repeat(30)}revenue ${'suffix '.repeat(100)}`, 'revenue');
		expect(result.text.length).toBeLessThanOrEqual(400);
		expect(result.text.trim()).toMatch(/^(prefix )*revenue( suffix)*$/);
		expect(result.highlights.map(({ start, end }) => result.text.slice(start, end))).toEqual([
			'revenue',
		]);
	});
	it('preserves surrogate pairs at both excerpt boundaries', () => {
		const result = snippet(
			`${'x'.repeat(101)}${'😀'.repeat(50)} revenue ${'😀'.repeat(200)}`,
			'revenue',
		);
		expect(result.text.isWellFormed()).toBe(true);
		expect(result.text.length).toBeLessThanOrEqual(400);
		expect(result.highlights.map(({ start, end }) => result.text.slice(start, end))).toEqual([
			'revenue',
		]);
	});
	it('bounds a single long token and highlights combining marks consistently', () => {
		expect(snippet('x'.repeat(1000), 'missing').text).toHaveLength(400);
		expect(terms('Café हिंदी')).toEqual(terms('café हिंदी'));
		const result = snippet('Café हिंदी', 'café हिंदी');
		expect(result.highlights.map(({ start, end }) => result.text.slice(start, end))).toEqual([
			'Café',
			'हिंदी',
		]);
	});
});
