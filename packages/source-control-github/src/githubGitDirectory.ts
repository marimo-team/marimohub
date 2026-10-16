import { materializeGitDirectory as materialize } from '@marimo-hub/source-control-git';
import type { GitHubFetch } from './githubClient';
export function materializeGitDirectory(options: {
	origin?: string;
	repository: string;
	owner: string;
	repo: string;
	commit: string;
	branch: string;
	token: string;
	fetcher: GitHubFetch;
}) {
	return materialize({
		repository: options.repository,
		remoteUrl: `${options.origin ?? 'https://github.com'}/${options.owner}/${options.repo}.git`,
		commit: options.commit,
		branch: options.branch,
		authorization: `Basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`,
		fetcher: options.fetcher,
	});
}
