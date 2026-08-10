import { describe, expect, it } from 'vitest';
import { Utf8TailBuffer } from './node';

describe('Utf8TailBuffer', () => {
	it('retains only the configured trailing characters', () => {
		const buffer = new Utf8TailBuffer(5);
		buffer.append(Buffer.from('abc'));
		buffer.append(Buffer.from('defg'));
		expect(buffer.toString()).toBe('cdefg');
	});

	it('decodes a UTF-8 character split across chunks', () => {
		const buffer = new Utf8TailBuffer(10);
		buffer.append(Buffer.from([0xc3]));
		expect(buffer.toString()).toBe('');
		buffer.append(Buffer.from([0xa9]));
		expect(buffer.toString()).toBe('é');
	});
});
