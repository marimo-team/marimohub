import { describe, expect, it } from 'vitest';
import { ValidationError } from '@marimo-hub/core/errors';
import { gitLabOrigin, parseGitLabRepository } from './repository';

describe('GitLab repository configuration', () => {
	it.each(['not a URL', '', 'https://', 'http://gitlab.com', 'https://gitlab.com/path'])(
		'rejects invalid origin %s with a validation error',
		(value) => {
			expect(() => gitLabOrigin(value)).toThrow(ValidationError);
			expect(() => gitLabOrigin(value)).toThrow('GitLab server URL must be an HTTPS origin');
		},
	);

	it.each(['https://gitlab.com/project', 'https:///gitlab.com/g/r'])(
		'explains an invalid repository path in %s',
		(value) => {
			expect(() => parseGitLabRepository(value)).toThrow(
				'Repository must be an HTTPS URL with a group/project path',
			);
		},
	);

	it('distinguishes a different origin from an invalid path', () => {
		expect(() => parseGitLabRepository('https://other.example/group/project')).toThrow(
			'Repository must use the configured GitLab HTTPS origin',
		);
	});
});
