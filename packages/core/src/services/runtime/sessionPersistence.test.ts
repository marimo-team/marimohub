import { describe, expect, it } from 'vitest';
import type { Source } from '../../schema';
import { effectivePersistenceMode } from './sessionPersistence';

const local = { schema_version: 1, type: 'local' } as Source;
const git = { schema_version: 1, type: 'git', entry_notebook: 'app.py' } as Source;

describe('effectivePersistenceMode', () => {
	it.each([
		{ persistEdits: true, source: local, persistWorkspace: 'source', expected: 'source' },
		{ persistEdits: true, source: local, persistWorkspace: 'workspace', expected: 'workspace' },
		{ persistEdits: false, source: local, persistWorkspace: 'workspace', expected: 'none' },
		{ persistEdits: true, source: git, persistWorkspace: 'workspace', expected: 'none' },
		{ persistEdits: false, source: git, persistWorkspace: 'source', expected: 'none' },
	] as const)('$source.type persistEdits=$persistEdits $persistWorkspace -> $expected', (input) => {
		expect(effectivePersistenceMode(input)).toBe(input.expected);
	});
});
