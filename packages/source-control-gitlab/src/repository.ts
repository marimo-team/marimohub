import { ValidationError } from '@marimo-hub/core/errors';
import { gitLabRepository } from '@marimo-hub/core/git-repo';

export function gitLabOrigin(value = 'https://gitlab.com'): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ValidationError('GitLab server URL must be an HTTPS origin');
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!/^https:\/\/[^/]+\/?$/i.test(value) ||
		/[\\\s]/.test(value)
	)
		throw new ValidationError('GitLab server URL must be an HTTPS origin');
	return url.origin;
}

export function parseGitLabRepository(value: string, origin = 'https://gitlab.com') {
	const parsed = gitLabRepository(value);
	if (!parsed)
		throw new ValidationError('Repository must be an HTTPS URL with a group/project path');
	const { url } = parsed;
	if (new URL(url).origin !== origin)
		throw new ValidationError('Repository must use the configured GitLab HTTPS origin');
	const path = parsed.parts.join('/');
	return {
		url,
		path,
		apiUrl: `${origin}/api/v4/projects/${encodeURIComponent(path)}`,
		remoteUrl: `${url}.git`,
	};
}

export type GitLabRepository = ReturnType<typeof parseGitLabRepository>;
