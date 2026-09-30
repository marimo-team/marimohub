import { describe, expect, it } from 'vitest';
import { validateRootPath } from './githubWorkspace';

describe('validateRootPath', () => {
	it.each(['', 'apps', 'python/apps', 'a/.github'])('accepts %j', (rootPath) => {
		expect(() => validateRootPath(rootPath)).not.toThrow();
	});

	it.each([undefined, 42, '/apps', 'apps/', '../x', 'a/../b', '.git', 'pkg/.GIT', 'a\u0001b'])(
		'rejects %j',
		(rootPath) => {
			expect(() => validateRootPath(rootPath)).toThrow('Invalid workspace root path');
		},
	);
});
