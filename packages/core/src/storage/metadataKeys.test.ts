import { describe, expect, it } from 'vitest';
import { paths } from '../paths';
import { buildBucketSpec } from '../specs/bucketSpec';
import { classifyMetadataKey } from './metadataKeys';

describe('metadata placement manifest', () => {
	it('covers every concrete path produced by the shared constructors', () => {
		function visit(value: unknown, name = ''): void {
			if (typeof value === 'function') {
				visit(value('run-00000000000000000000000000', 'fixture', 'fixture', 'fixture'), name);
			} else if (typeof value === 'string') {
				if (name !== 'base' && !value.endsWith('/')) {
					expect(() => classifyMetadataKey(value), name).not.toThrow();
				}
			} else if (value && typeof value === 'object') {
				for (const [key, child] of Object.entries(value)) visit(child, key);
			}
		}
		visit(paths);
	});

	it('classifies every documented stored object and artifact', () => {
		const spec = buildBucketSpec();
		for (const key of Object.keys(spec.paths as object)) {
			expect(() => classifyMetadataKey(key.slice(1))).not.toThrow();
		}
	});

	it.each([
		'projects/p/notebooks/n/workspace/meta.json',
		'projects/p/notebooks/n/versions/v/session.json',
		'projects/p/notebooks/n/versions/v/captures/c/session.json',
		'_system/working-branches/notebooks/p/n/saves/s/capture.json',
		'projects/p/notebooks/n/proposals/p/changes/0',
		'projects/p/object-uploads/u/parts/1',
	])('keeps payload %s in artifacts', (key) => {
		expect(classifyMetadataKey(key)).toBe('artifact');
	});

	it.each([
		'_system/source-control-accounts/u/head.json',
		'_system/source-control-accounts/u/connection.json',
		'_system/search/projects/p/source/pages/page.json',
		'_system/search/lock.json',
		'_system/_maintenance.lock',
		'_system/notebook-gc-cursor.json',
		'projects/p/notebooks/n/jobs/j//prune-runs.json',
		'projects/p/notebooks/n/jobs/j//prune-occurrences.json',
		'projects/p/notebooks/n/uploads/index.json',
	])('keeps operational record %s in metadata', (key) => {
		expect(classifyMetadataKey(key)).toBe('metadata');
	});

	it('fails closed for undeclared families', () => {
		for (const key of ['other.json', '_system/new-family/a.json', 'projects/p/unknown.json']) {
			expect(() => classifyMetadataKey(key)).toThrow('Unclassified');
		}
		expect(classifyMetadataKey('_system/metadata-backend.json')).toBe('control');
	});
});
