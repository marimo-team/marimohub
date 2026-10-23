import { describe, expect, it } from 'vitest';
import { mergePresentationFiles } from './presentation';

describe('mergePresentationFiles', () => {
	it('ignores empty layers without creating a presentation requirement', () => {
		expect(mergePresentationFiles(undefined, {}, { cssFiles: [] })).toBeUndefined();
	});

	it('preserves first occurrence order across missing and repeated layers without aliasing input arrays', () => {
		const first = { cssFiles: ['/b.css', '/a.css', '/b.css'], htmlHeadFile: '/head.html' };
		const second = { cssFiles: ['/c.css', '/a.css'], htmlHeadFile: '/head.html' };
		const original = structuredClone([first, second]);
		const merged = mergePresentationFiles(first, undefined, {}, second)!;
		expect(merged).toEqual({
			cssFiles: ['/b.css', '/a.css', '/c.css'],
			htmlHeadFile: '/head.html',
		});
		merged.cssFiles!.push('/new.css');
		expect([first, second]).toEqual(original);
	});

	it('rejects nonadjacent head conflicts without disclosing paths or changing inputs', () => {
		const layers = [
			{ htmlHeadFile: '/private/one.html' },
			{ cssFiles: ['/a.css'] },
			{ htmlHeadFile: '/private/two.html' },
		];
		const original = structuredClone(layers);
		expect(() => mergePresentationFiles(...layers)).toThrow(
			'Cannot combine different bundled HTML head files.',
		);
		expect(() => mergePresentationFiles(...layers)).not.toThrow('/private');
		expect(layers).toEqual(original);
	});
});
