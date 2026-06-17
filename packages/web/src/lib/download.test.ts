import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizeFilename, triggerDownload } from './download';

describe('sanitizeFilename', () => {
	it('keeps safe characters intact', () => {
		expect(sanitizeFilename('my_analysis-v2.final')).toBe('my_analysis-v2.final');
	});

	it('collapses runs of unsupported characters to a single underscore', () => {
		expect(sanitizeFilename('Revenue / Q1 (2025)')).toBe('Revenue_Q1_2025');
	});

	it('trims leading and trailing underscores produced by sanitizing', () => {
		expect(sanitizeFilename('  !!hello!!  ')).toBe('hello');
	});

	it('falls back to "notebook" when nothing usable remains', () => {
		expect(sanitizeFilename('   ')).toBe('notebook');
		expect(sanitizeFilename('***')).toBe('notebook');
	});
});

describe('triggerDownload', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('clicks a transient anchor with the filename and revokes the object URL', () => {
		const createObjectURL = vi.fn(() => 'blob:fake');
		const revokeObjectURL = vi.fn();
		vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

		const blob = new Blob(['print(1)'], { type: 'text/x-python' });
		triggerDownload('analysis.py', blob);

		expect(createObjectURL).toHaveBeenCalledWith(blob);
		expect(click).toHaveBeenCalledTimes(1);
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
		// The anchor is cleaned up after the click.
		expect(document.querySelector('a[download]')).toBeNull();

		vi.unstubAllGlobals();
	});
});
