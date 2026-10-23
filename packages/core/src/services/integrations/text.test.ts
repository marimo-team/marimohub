import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultRegistry } from './kinds';
import { textFileContent } from './text';

describe('textFileContent', () => {
	const schema = textFileContent('Text file');

	it('retains byte limits and descriptions after content validation', () => {
		expect(z.toJSONSchema(schema)).toMatchObject({
			'x-max-utf8-bytes': 65536,
			description: 'Text file. Maximum 65536 UTF-8 bytes.',
		});
	});

	it.each([
		['custom_css', 'css'],
		['html_head', 'html'],
		['startup_script', 'script'],
	])('exposes file import byte limits in the %s descriptor', (kind, field) => {
		expect(defaultRegistry().describe(kind).json_schema).toMatchObject({
			properties: {
				[field]: {
					'x-max-utf8-bytes': 65536,
					description: expect.stringContaining('Maximum 65536 UTF-8 bytes.'),
				},
			},
		});
	});

	it.each(['\uFEFF', '\u00a0\u2003\t\r\n', '\0', 'valid\0text'])(
		'rejects invisible and binary content %#',
		(text) => {
			expect(schema.safeParse(text).success).toBe(false);
		},
	);

	it.each(['x'.repeat(65536), 'é'.repeat(32768), '🙂'.repeat(16384)])(
		'enforces the UTF-8 boundary without truncation %#',
		(text) => {
			expect(schema.parse(text)).toBe(text);
			expect(schema.safeParse(`${text}x`).success).toBe(false);
		},
	);

	it('preserves BOM, Unicode, and line endings in nonblank content', () => {
		const text = '\uFEFF/* café 🙂 */\r\nbody {}\r\n';
		expect(schema.parse(text)).toBe(text);
	});
});
