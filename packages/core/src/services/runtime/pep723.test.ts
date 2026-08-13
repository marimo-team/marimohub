import { describe, expect, it } from 'vitest';
import { hasInlineScriptMetadata } from './pep723';

const CANONICAL = [
	'# /// script',
	'# requires-python = ">=3.12"',
	'# dependencies = [',
	'#   "cowsay==6.1",',
	'# ]',
	'# ///',
	'',
	'import cowsay',
].join('\n');

// Every case verified against `uv export --script`: true = uv sees metadata
// (exports it, or errors loudly on a malformed block); false = uv reports no
// metadata tag.
describe('hasInlineScriptMetadata', () => {
	it('matches a canonical block', () => {
		expect(hasInlineScriptMetadata(CANONICAL)).toBe(true);
	});

	it('matches CRLF line endings', () => {
		expect(hasInlineScriptMetadata(CANONICAL.replaceAll('\n', '\r\n'))).toBe(true);
	});

	it('matches a block that is not at the top of the file', () => {
		expect(hasInlineScriptMetadata(`"""Docstring."""\n\n${CANONICAL}`)).toBe(true);
	});

	it('matches a closing fence at EOF with no trailing newline', () => {
		expect(hasInlineScriptMetadata('# /// script\n# dependencies = ["cowsay"]\n# ///')).toBe(true);
	});

	it('matches a tag at EOF with no trailing newline', () => {
		expect(hasInlineScriptMetadata('# /// script')).toBe(true);
	});

	it('matches an empty block (uv exports it fine)', () => {
		expect(hasInlineScriptMetadata('# /// script\n# ///\nimport os')).toBe(true);
	});

	it('matches a malformed block — uv errors loudly rather than silently ignoring it', () => {
		expect(
			hasInlineScriptMetadata('# /// script\n# dependencies = ["cowsay"]\n\n# ///\nimport os'),
		).toBe(true);
		expect(hasInlineScriptMetadata('# /// script\nimport os')).toBe(true);
	});

	it('ignores a tag with trailing whitespace (uv does too)', () => {
		expect(hasInlineScriptMetadata('# /// script  \n# dependencies = []\n# ///')).toBe(false);
		expect(hasInlineScriptMetadata('# /// script\t\n# dependencies = []\n# ///')).toBe(false);
	});

	it('ignores an indented tag (uv does too)', () => {
		expect(hasInlineScriptMetadata('  # /// script\n# dependencies = []\n# ///')).toBe(false);
	});

	it('ignores other metadata types', () => {
		expect(hasInlineScriptMetadata('# /// pyproject\n# dependencies = ["cowsay"]\n# ///')).toBe(
			false,
		);
	});

	it('ignores a lookalike comment line', () => {
		expect(hasInlineScriptMetadata('# # /// script\n# ///')).toBe(false);
	});

	it('ignores an empty file', () => {
		expect(hasInlineScriptMetadata('')).toBe(false);
	});
});
