import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TagFieldValue } from '@/lib/tagFieldValue';
import { TagField } from './TagField';

function TestField() {
	const [value, setValue] = useState(() => TagFieldValue.fromTags([]));
	return (
		<>
			<TagField label="Tags" value={value} onChange={setValue} />
			<output aria-label="Saved tags">{JSON.stringify(value.tags)}</output>
		</>
	);
}

function inputAtEnd(input: HTMLElement, inputType: string, data: string | null = null) {
	input.focus();
	const range = document.createRange();
	range.selectNodeContents(input);
	range.collapse(false);
	window.getSelection()!.removeAllRanges();
	window.getSelection()!.addRange(range);
	// jsdom does not generate contenteditable beforeinput events from key presses.
	fireEvent(
		input,
		new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data }),
	);
}

describe('TagField', () => {
	it.each([
		['Enter', 'insertParagraph'],
		['Shift+Enter', 'insertLineBreak'],
	])('commits a tag with %s before subsequent text', (_, inputType) => {
		render(<TestField />);
		const input = screen.getByRole('textbox', { name: 'Tags' });
		inputAtEnd(input, 'insertText', 'foo');
		inputAtEnd(input, inputType);
		expect(input.querySelector('[contenteditable="false"]')).toHaveTextContent('foo');
		inputAtEnd(input, 'insertText', 'bar');
		expect(screen.getByLabelText('Saved tags')).toHaveTextContent('["foo","bar"]');
	});

	it('splits multiline paste into separate tags without losing spaces within tags', () => {
		render(<TestField />);
		const input = screen.getByRole('textbox', { name: 'Tags' });
		inputAtEnd(input, 'insertFromPaste', 'foo\nData Team\r\nbar');
		expect(screen.getByLabelText('Saved tags')).toHaveTextContent('["foo","Data Team","bar"]');
	});
});
