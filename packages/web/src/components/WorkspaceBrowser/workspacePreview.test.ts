import { describe, expect, it } from 'vitest';
import {
	decodeWorkspaceText,
	isWorkspaceTextFile,
	MAX_TEXT_EDITOR_BYTES,
} from './workspacePreview';

describe('workspace preview helpers', () => {
	it.each([
		['script.py', 'application/octet-stream'],
		['README', 'text/plain'],
		['config.toml', 'application/toml'],
		['data.JSON', undefined],
	])('recognizes text file %s', (name, mimeType) => {
		expect(isWorkspaceTextFile({ name, mimeType })).toBe(true);
	});

	it('does not classify images or extensionless binary files as text', () => {
		expect(isWorkspaceTextFile({ name: 'image.png', mimeType: 'image/png' })).toBe(false);
		expect(isWorkspaceTextFile({ name: 'archive', mimeType: 'application/octet-stream' })).toBe(
			false,
		);
	});

	it('decodes valid UTF-8 and rejects invalid bytes', () => {
		expect(decodeWorkspaceText(new TextEncoder().encode('héllo').buffer)).toBe('héllo');
		expect(decodeWorkspaceText(Uint8Array.from([0xc3, 0x28]).buffer)).toBeNull();
	});

	it('keeps the editor limit at one MiB', () => {
		expect(MAX_TEXT_EDITOR_BYTES).toBe(1024 * 1024);
	});
});
