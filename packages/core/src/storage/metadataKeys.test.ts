import type { Node } from 'typescript';
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
		'_system/.cas-probe',
		'_system/.cas-probe-00000000-0000-4000-8000-000000000000',
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
		'_system/dev/local-notebook-seed.json',
		'_system/retention-notebook_gc-lock.json',
		'_system/retention-snapshot_expiry-lock.json',
		'_system/retention-jobs-lock.json',
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

it('classifies literal key families declared outside the shared path builders', async () => {
	const { readFile, readdir } = await import('node:fs/promises');
	const ts = await import('typescript');
	const core = new URL('../', import.meta.url);
	const roots = [
		core,
		new URL('../../../api/src/', import.meta.url),
		new URL('../../../../apps/server/src/', import.meta.url),
	];
	const keys = new Set<string>();
	for (const root of roots) {
		const files = await readdir(root, { recursive: true });
		for (const file of files) {
			if (
				!file.endsWith('.ts') ||
				file.endsWith('.test.ts') ||
				(root === core &&
					(file.startsWith('testing/') || file.startsWith('specs/') || file.startsWith('storage/')))
			)
				continue;
			const text = await readFile(new URL(file, root), 'utf8');
			if (!text.includes('_system/') && !text.includes('projects/')) continue;
			const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
			function visit(node: Node): void {
				let key: string | undefined;
				if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) key = node.text;
				else if (ts.isTemplateExpression(node))
					key =
						node.head.text +
						node.templateSpans.map((span) => `fixture${span.literal.text}`).join('');
				if (key && /^(?:_system|projects)\//.test(key) && /(?:\.json|\.lock)$/.test(key))
					keys.add(key);
				ts.forEachChild(node, visit);
			}
			visit(source);
		}
	}
	// cron.ts interpolates a closed set of task names; the retention lock cases above cover them.
	keys.delete('_system/retention-fixture-lock.json');
	expect(keys).toContain('_system/dev/local-notebook-seed.json');
	expect(keys.size).toBeGreaterThan(20);
	for (const key of keys) expect(() => classifyMetadataKey(key), key).not.toThrow();
});
