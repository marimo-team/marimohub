import { describe, expect, it } from 'vitest';
import { textFileContent } from './text';

describe('textFileContent', () => {
	const schema = textFileContent('Text file');

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
