import { describe, expect, it } from 'vitest';
import { createSessionId } from '../../ids';
import type { IntegrationId } from '../../ids';
import { bundleIntegrations, INTEGRATIONS_DIR, INTEGRATIONS_DIR_ENV } from './bundle';
import type { RenderedIntegration } from './bundle';
import type { RenderOutput } from './sdk';

const rendered = (name: string, output: RenderOutput): RenderedIntegration => ({
	id: 'intg-0000000000000001' as IntegrationId,
	name,
	kind: 'synthetic',
	version: 1,
	output,
});

const bundle = (items: RenderedIntegration[]) => bundleIntegrations(items, createSessionId());

const file = (path: string, content = 'x') => ({ files: [{ path, content }] });
const yaml = (path: string, value: Record<string, unknown> = { a: 1 }) => ({
	yamlFiles: [{ path, value }],
});

describe('rendered path collisions', () => {
	it('rejects a file nested under a sibling integration file', () => {
		expect(() =>
			bundle([rendered('first', file('foo')), rendered('second', file('foo/bar'))]),
		).toThrow(/needs it to be a directory/);
	});

	it('rejects a file rendered on a sibling integration directory', () => {
		expect(() =>
			bundle([rendered('first', file('foo/bar')), rendered('second', file('foo'))]),
		).toThrow(/needs it to be a directory/);
	});

	it('rejects a file nested under a rendered YAML file, and the reverse', () => {
		expect(() =>
			bundle([rendered('first', yaml('cfg')), rendered('second', file('cfg/x'))]),
		).toThrow(/needs it to be a directory/);
		expect(() =>
			bundle([rendered('first', file('cfg/x')), rendered('second', yaml('cfg'))]),
		).toThrow(/needs it to be a directory/);
	});

	it('rejects a deep nesting collision and a self-collision within one integration', () => {
		expect(() =>
			bundle([rendered('first', file('a/b/c')), rendered('second', file('a/b/c/d/e'))]),
		).toThrow(/needs it to be a directory/);
		expect(() =>
			bundle([
				rendered('solo', {
					files: [
						{ path: 'a', content: 'x' },
						{ path: 'a/b', content: 'y' },
					],
				}),
			]),
		).toThrow(/needs it to be a directory/);
	});

	it('still rejects an exact cross-integration file collision', () => {
		expect(() =>
			bundle([rendered('first', file('same')), rendered('second', file('same'))]),
		).toThrow(/both render "same"/);
		expect(() =>
			bundle([rendered('first', file('same')), rendered('second', yaml('same'))]),
		).toThrow(/both render "same"/);
	});

	it('permits sibling paths that merely share a name prefix, and merges shared YAML', () => {
		const result = bundle([
			rendered('first', file('trino/prod.json')),
			rendered('second', file('trino/prod-client.crt')),
			rendered('third', yaml('.pyiceberg.yaml', { catalog: { a: 1 } })),
			rendered('fourth', yaml('.pyiceberg.yaml', { catalog: { b: 2 } })),
		]);
		const paths = result.files.map((f) => f.path);
		expect(paths).toContain(`${INTEGRATIONS_DIR}/trino/prod.json`);
		expect(paths).toContain(`${INTEGRATIONS_DIR}/trino/prod-client.crt`);
		const merged = result.files.find((f) => f.path.endsWith('.pyiceberg.yaml'));
		expect(merged?.content).toContain('a: 1');
		expect(merged?.content).toContain('b: 2');
	});
});

describe('process-wide YAML settings', () => {
	// The real case: the BigQuery catalog requires legacy-current-snapshot-id, so
	// it cannot share a session with a catalog that turns it off. This only bites
	// at launch, so the message has to carry everything needed to act on it.
	it('names both integrations and both values when a root property disagrees', () => {
		expect(() =>
			bundle([
				rendered('warehouse', yaml('.pyiceberg.yaml', { 'legacy-current-snapshot-id': 'true' })),
				rendered('lakehouse', yaml('.pyiceberg.yaml', { 'legacy-current-snapshot-id': 'false' })),
			]),
		).toThrow(
			/Integrations "warehouse" and "lakehouse" disagree on "legacy-current-snapshot-id".*"true" vs "false"/s,
		);
	});

	it('still merges disjoint catalogs into one file', () => {
		const result = bundle([
			rendered('a', yaml('.pyiceberg.yaml', { catalog: { a: { uri: 'https://a' } } })),
			rendered('b', yaml('.pyiceberg.yaml', { catalog: { b: { uri: 'https://b' } } })),
		]);
		const merged = result.files.find((f) => f.path.endsWith('.pyiceberg.yaml'));
		expect(merged?.content).toContain('https://a');
		expect(merged?.content).toContain('https://b');
	});
});

describe('bundler-owned env', () => {
	it('rejects a kind that sets the integrations-dir var to another value', () => {
		expect(() =>
			bundle([rendered('greedy', { env: { [INTEGRATIONS_DIR_ENV]: '/tmp/evil' } })]),
		).toThrow(/different values/);
	});

	it('always exports the integrations dir, and tolerates a kind echoing it', () => {
		const result = bundle([
			rendered('echo', { env: { [INTEGRATIONS_DIR_ENV]: INTEGRATIONS_DIR } }),
		]);
		expect(result.vars[INTEGRATIONS_DIR_ENV]).toBe(INTEGRATIONS_DIR);
	});
});
