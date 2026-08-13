import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import {
	allSqlStatements,
	applySqlTarget,
	csvCell,
	selectedOrCurrentStatement,
	sqlTargetAtState,
} from './SqlWorkspace';

describe('SQL statement selection', () => {
	it('prefers a non-empty selection', () => {
		const state = EditorState.create({
			doc: 'SELECT 1; SELECT 2;',
			selection: EditorSelection.range(10, 18),
		});
		expect(selectedOrCurrentStatement(state)).toBe('SELECT 2');
	});

	it('uses the statement around the cursor', () => {
		const state = EditorState.create({
			doc: 'SELECT 1;\nSELECT 2;\nSELECT 3;',
			selection: EditorSelection.cursor(15),
		});
		expect(selectedOrCurrentStatement(state)).toBe('SELECT 2');
	});

	it('falls back to the full document when there is no separator', () => {
		const state = EditorState.create({ doc: '  SELECT 42  ' });
		expect(selectedOrCurrentStatement(state)).toBe('SELECT 42');
	});

	it.each([
		["SELECT 'a;b';\nSELECT 2;", 8, "SELECT 'a;b'"],
		['SELECT 1 /* ; */;\nSELECT 2;', 13, 'SELECT 1 /* ; */'],
		['SELECT 1 -- ;\n;\nSELECT 2;', 12, 'SELECT 1 -- ;'],
		['SELECT $$a;b$$;\nSELECT 2;', 10, 'SELECT $$a;b$$'],
	])('ignores semicolons in literals and comments', (doc, cursor, expected) => {
		const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) });
		expect(selectedOrCurrentStatement(state)).toBe(expected);
	});

	it('uses the last statement from trailing whitespace', () => {
		const doc = 'SELECT 1;\nSELECT 2;\n\n  ';
		const state = EditorState.create({ doc, selection: EditorSelection.cursor(doc.length) });
		expect(selectedOrCurrentStatement(state)).toBe('SELECT 2');
	});

	it('splits Run All input without splitting literals or comments', () => {
		expect(allSqlStatements("SELECT 'a;b'; -- separator ;\nSELECT 2;\n-- tail only")).toEqual([
			"SELECT 'a;b';",
			'-- separator ;\nSELECT 2;',
		]);
	});

	it('replaces only the selected SQL and rejects a stale AI target', () => {
		const document = 'SELECT 1;\nSELECT old_value;\nSELECT 3;';
		const from = document.indexOf('old_value');
		const state = EditorState.create({
			doc: document,
			selection: EditorSelection.range(from, from + 'old_value'.length),
		});
		const target = sqlTargetAtState(state);
		expect(applySqlTarget(document, target, 'new_value')).toBe(
			'SELECT 1;\nSELECT new_value;\nSELECT 3;',
		);
		expect(applySqlTarget(`${document}\n-- edited`, target, 'new_value')).toBeUndefined();
	});
});

describe('CSV serialization', () => {
	it.each([
		['=1+1', "'=1+1"],
		[' +cmd', "' +cmd"],
		['\t@import', "'\t@import"],
		[-42, '-42'],
		['normal', 'normal'],
		['a,b', '"a,b"'],
		['say "hi"', '"say ""hi"""'],
	])('serializes %j safely', (value, expected) => {
		expect(csvCell(value)).toBe(expected);
	});
});
