import { describe, expect, it, vi } from 'vitest';
import type { GitHubClient } from './githubClient';
import { GitHubPullRequests } from './githubPullRequests';
import type { GitHubRepositoryWriter } from './githubRepository';

const changeRequest = {
	number: 17,
	url: 'https://github.com/owner/repo/pull/17',
	headBranch: 'marimohub/notebook/proposal',
	headCommit: 'previous-head',
};

const updateInput = {
	repository: 'owner/repo',
	baseBranch: 'main',
	baseCommit: 'base-sha',
	changeRequest,
	title: 'Updated title',
	body: '',
	changes: [
		{
			path: 'notebook.py',
			operation: 'modify' as const,
			content: new Uint8Array(),
		},
	],
};

function response(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

function pullRequests(value: unknown) {
	const request = vi.fn().mockResolvedValue(response(value));
	const client = { request } as unknown as GitHubClient;
	const repository = {} as GitHubRepositoryWriter;
	return {
		request,
		pullRequests: new GitHubPullRequests(client, repository, 'owner', 'repo', 'installation-token'),
	};
}

function updatedPull(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		number: 17,
		html_url: changeRequest.url,
		title: updateInput.title,
		body: updateInput.body,
		head: { sha: 'updated-head' },
		...overrides,
	};
}

describe('GitHubPullRequests.updateMetadata', () => {
	it('patches the numbered pull request and accepts an explicit empty body', async () => {
		const { pullRequests: githubPullRequests, request } = pullRequests(updatedPull());

		await expect(githubPullRequests.updateMetadata(updateInput, 'updated-head')).resolves.toEqual({
			...changeRequest,
			headCommit: 'updated-head',
		});
		expect(request).toHaveBeenCalledWith('/repos/owner/repo/pulls/17', 'installation-token', {
			method: 'PATCH',
			body: JSON.stringify({ title: updateInput.title, body: '' }),
		});
	});

	it.each([
		['changed title', { title: 'Ignored title' }],
		['changed body', { body: 'Ignored body' }],
		['missing title', { title: undefined }],
		['null body', { body: null }],
	])('rejects a response with %s', async (_description, overrides) => {
		const { pullRequests: githubPullRequests } = pullRequests(updatedPull(overrides));

		await expect(githubPullRequests.updateMetadata(updateInput, 'updated-head')).rejects.toThrow(
			'unexpected updated pull request metadata',
		);
	});
});
