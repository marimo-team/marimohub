import { describe, expect, it } from 'vitest';
import { mdUrlForPath } from './mdUrl';

describe('mdUrlForPath', () => {
	it('maps the root to index.md', () => {
		expect(mdUrlForPath('/')).toBe('/index.md');
		expect(mdUrlForPath('/index.html')).toBe('/index.md');
	});

	it('maps clean URLs to sibling .md files', () => {
		expect(mdUrlForPath('/storage')).toBe('/storage.md');
		expect(mdUrlForPath('/deploying/cks')).toBe('/deploying/cks.md');
	});

	it('maps directory URLs to the flattened twin', () => {
		expect(mdUrlForPath('/deploying/')).toBe('/deploying.md');
	});

	it('maps .html URLs to .md', () => {
		expect(mdUrlForPath('/storage.html')).toBe('/storage.md');
	});

	it('drops query strings and hashes', () => {
		expect(mdUrlForPath('/storage?foo=1#s3')).toBe('/storage.md');
	});
});
