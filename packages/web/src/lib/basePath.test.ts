import { describe, expect, it } from 'vitest';
import { appBasePath, withBasePath } from './basePath';

describe('appBasePath', () => {
	it.each([
		['https://hub.example.com', '/'],
		['https://hub.example.com/', '/'],
		['https://hub.example.com/marimohub', '/marimohub'],
		['https://hub.example.com/marimohub/', '/marimohub'],
		['https://hub.example.com/marimohub///?ignored=1#ignored', '/marimohub'],
		['https://hub.example.com/team%20one/hub/', '/team%20one/hub'],
	] as const)('reads %s as %s', (baseUri, expected) => {
		expect(appBasePath(baseUri)).toBe(expected);
	});

	it.each(['/marimohub', '/marimohub/', '/marimohub///'])('reads base element %s', (href) => {
		const base = document.createElement('base');
		base.href = href;
		document.head.append(base);
		try {
			expect(appBasePath()).toBe('/marimohub');
		} finally {
			base.remove();
		}
	});

	it('does not infer a prefix from the current route without a base element', () => {
		const previousPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
		window.history.replaceState(null, '', '/projects/project-1?tab=data#cell');
		try {
			expect(appBasePath()).toBe('/');
		} finally {
			window.history.replaceState(null, '', previousPath);
		}
	});

	it.each(['not a URL', '/relative'])('rejects invalid explicit base URI %j', (baseUri) => {
		expect(() => appBasePath(baseUri)).toThrow(TypeError);
	});
});

describe('withBasePath', () => {
	it.each([
		['/', '/marimohub/', '/marimohub/'],
		['/', '/marimohub', '/marimohub/'],
		['/', '/marimohub///', '/marimohub/'],
		['/api/v1/me', '/marimohub/', '/marimohub/api/v1/me'],
		['/api/v1/me', '/', '/api/v1/me'],
		['/api/v1/me', '', '/api/v1/me'],
		['/marimohub', '/marimohub/', '/marimohub'],
		['/marimohub/projects', '/marimohub/', '/marimohub/projects'],
		['/marimohub-other', '/marimohub/', '/marimohub/marimohub-other'],
		['https://idp.example/logout', '/marimohub/', 'https://idp.example/logout'],
		['//cdn.example/app.js', '/marimohub/', '//cdn.example/app.js'],
		['projects/project-1', '/marimohub/', 'projects/project-1'],
		['?tab=data', '/marimohub/', '?tab=data'],
		['#cell', '/marimohub/', '#cell'],
		['', '/marimohub/', ''],
	] as const)('maps %s under %s to %s', (path, basePath, expected) => {
		expect(withBasePath(path, basePath)).toBe(expected);
	});
});
