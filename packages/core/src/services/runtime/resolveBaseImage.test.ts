import { describe, it, expect, vi } from 'vitest';
import { resolveBaseImage } from './resolveBaseImage';

const IMAGES = ['img-a', 'img-b', 'img-c'];

describe('resolveBaseImage', () => {
	it('returns undefined when no images are configured', () => {
		expect(resolveBaseImage(undefined, [])).toBeUndefined();
		expect(resolveBaseImage('img-a', [])).toBeUndefined();
	});

	it('resolves absent and "default" to the first image', () => {
		expect(resolveBaseImage(undefined, IMAGES)).toBe('img-a');
		expect(resolveBaseImage('default', IMAGES)).toBe('img-a');
	});

	it('returns a listed image as-is', () => {
		expect(resolveBaseImage('img-b', IMAGES)).toBe('img-b');
		expect(resolveBaseImage('img-a', IMAGES)).toBe('img-a');
	});

	it('falls back to the first image and warns when the choice is no longer listed', () => {
		const warn = vi.fn();
		expect(resolveBaseImage('img-gone', IMAGES, warn)).toBe('img-a');
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][0]).toContain('img-gone');
		expect(warn.mock.calls[0][0]).toContain('img-a');
	});

	it('does not warn on the default paths', () => {
		const warn = vi.fn();
		resolveBaseImage(undefined, IMAGES, warn);
		resolveBaseImage('default', IMAGES, warn);
		resolveBaseImage('img-b', IMAGES, warn);
		expect(warn).not.toHaveBeenCalled();
	});
});
