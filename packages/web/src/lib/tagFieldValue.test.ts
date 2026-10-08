import { describe, expect, it } from 'vitest';
import { TagFieldValue } from './tagFieldValue';

describe('TagFieldValue', () => {
	it('splits comma and newline input while preserving spaces within tags', () => {
		const value = TagFieldValue.fromTags([]);
		const edited = value.replaceRange(
			value.caretPosition,
			value.caretPosition,
			' research/vision, Data Team\nops\r\n, draft ',
		);
		expect(edited.tags).toEqual(['research/vision', 'Data Team', 'ops', 'draft']);
		expect(edited.toString()).toBe('research/vision, Data Team, ops, draft');
		expect(edited.segments.at(-1)).toEqual({ type: 'text', text: ' draft ' });
	});

	it('preserves existing tags exactly, including commas', () => {
		const tags = ['Research, Inc.', 'Data Team', 'Team/Repo'];
		expect(TagFieldValue.fromTags(tags).tags).toEqual(tags);
	});

	it('ignores blank and repeated separators', () => {
		const value = TagFieldValue.fromTags([]);
		expect(value.replaceRange(value.caretPosition, value.caretPosition, ', ,\n ').tags).toEqual([]);
	});
});
