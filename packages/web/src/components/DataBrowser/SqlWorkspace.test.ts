import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { selectedOrCurrentStatement } from './SqlWorkspace';

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
		expect(selectedOrCurrentStatement(state)).toBe('SELECT 2;');
	});

	it('falls back to the full document when there is no separator', () => {
		const state = EditorState.create({ doc: '  SELECT 42  ' });
		expect(selectedOrCurrentStatement(state)).toBe('SELECT 42');
	});

	it.each([
		["SELECT 'a;b';\nSELECT 2;", 8, "SELECT 'a;b';"],
		['SELECT 1 /* ; */;\nSELECT 2;', 13, 'SELECT 1 /* ; */;'],
		['SELECT 1 -- ;\n;\nSELECT 2;', 12, 'SELECT 1 -- ;\n;'],
		['SELECT $$a;b$$;\nSELECT 2;', 10, 'SELECT $$a;b$$;'],
	])('ignores semicolons in literals and comments', (doc, cursor, expected) => {
		const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) });
		expect(selectedOrCurrentStatement(state)).toBe(expected);
	});
});
