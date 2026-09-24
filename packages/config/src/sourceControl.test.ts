import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectId } from '@marimo-hub/core/ids';
import { GitHubAppPublisher } from '@marimo-hub/source-control-github';
import { makeSourceControl } from './sourceControl';

function privateKey(): string {
	return generateKeyPairSync('rsa', { modulusLength: 2048 })
		.privateKey.export({ type: 'pkcs8', format: 'pem' })
		.toString();
}

describe('makeSourceControl', () => {
	it('is disabled when GitHub App credentials are absent', () => {
		expect(makeSourceControl({})).toEqual({});
	});

	it('treats whitespace-only credentials as absent', () => {
		expect(
			makeSourceControl({
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '  ',
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: '\n',
			}),
		).toEqual({});
	});

	it('registers the GitHub adapter as publisher and reader without exposing other providers', () => {
		const result = makeSourceControl({
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123',
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: privateKey(),
		});
		if (!result.sourceControl) throw new Error('Expected source control configuration');

		expect(result.sourceControl.getPublisher('github')?.provider).toBe('github');
		expect(result.sourceControl.getPublisher('gitlab')).toBeUndefined();
		expect(result.sourceControl.getReader('github')?.provider).toBe('github');
		expect(result.sourceControl.getReader('gitlab')).toBeUndefined();
		expect(result.sourceControl.publisherProviders()).toEqual(['github']);
		expect(result.sourceControl.readerProviders()).toEqual(['github']);
	});

	it.each([
		[
			{ MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123' },
			'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY',
		],
		[
			{ MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: privateKey() },
			'MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID',
		],
	])('rejects partial GitHub App configuration', (env, variable) => {
		expect(() => makeSourceControl(env)).toThrow(new RegExp(variable));
	});

	it('rejects an invalid GitHub App private key at startup', () => {
		expect(() =>
			makeSourceControl({
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123',
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: 'not-a-key',
			}),
		).toThrow(/MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY/);
	});

	it.each(['not-an-id', '0', '-1', '1.5'])('rejects invalid GitHub App id %s', (appId) => {
		expect(() =>
			makeSourceControl({
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: appId,
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: privateKey(),
			}),
		).toThrow(/must be a positive integer/);
	});

	it('trims the app id and accepts a base64-encoded private key', () => {
		const result = makeSourceControl({
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: ' 123 ',
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey()).toString('base64'),
		});
		expect(result.sourceControl?.publisherProviders()).toEqual(['github']);
	});

	it('does not include invalid private-key material in configuration errors', () => {
		const secret = 'not-a-key-secret-value';
		let thrown: unknown;
		try {
			makeSourceControl({
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123',
				MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: secret,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).not.toContain(secret);
	});
});

afterEach(() => vi.restoreAllMocks());
describe('GitHub repository policies', () => {
	const projectId = ProjectId.parse('proj-0000000000000000');
	const key = privateKey();
	function registry(policy: unknown) {
		return makeSourceControl({
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID: '123',
			MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_PRIVATE_KEY: key,
			MARIMOHUB_SOURCE_CONTROL_GITHUB_ALLOWED_REPOSITORIES: JSON.stringify(policy),
		}).sourceControl!;
	}
	const rule = [{ resource: 'https://github.com/Team/Repo.git', projects: [projectId] }];
	it('canonicalizes repository coordinates and binds every read to the project', async () => {
		const head = vi
			.spyOn(GitHubAppPublisher.prototype, 'getBranchHead')
			.mockResolvedValue({ commit: 'abc' });
		const files = vi.spyOn(GitHubAppPublisher.prototype, 'fetchWorkspace').mockResolvedValue([]);
		const git = vi.spyOn(GitHubAppPublisher.prototype, 'fetchGitDirectory').mockResolvedValue([]);
		const sources = registry(rule);
		const allowed = sources.getReader('github', projectId)!;
		expect(allowed.supportsRepository('team/repo')).toBe(true);
		await allowed.getBranchHead('team/repo', 'main');
		await allowed.fetchWorkspace('team/repo', 'abc', '.');
		await allowed.fetchGitDirectory!('team/repo', 'abc', 'main');
		for (const pid of [undefined, ProjectId.parse('proj-1111111111111111')]) {
			const denied = sources.getReader('github', pid)!;
			expect(() => denied.supportsRepository('team/repo')).toThrow('not allowed');
			await expect(denied.getBranchHead('team/repo', 'main')).rejects.toThrow('not allowed');
			await expect(denied.fetchWorkspace('team/repo', 'abc', '.')).rejects.toThrow('not allowed');
			await expect(denied.fetchGitDirectory!('team/repo', 'abc', 'main')).rejects.toThrow(
				'not allowed',
			);
		}
		await expect(allowed.getBranchHead('team/other', 'main')).rejects.toThrow('not allowed');
		for (const call of [head, files, git]) expect(call).toHaveBeenCalledOnce();
	});
	it('checks publishing and retries before using the GitHub App', async () => {
		const result = {
			number: 1,
			url: 'https://github.com/team/repo/pull/1',
			headBranch: 'change',
			headCommit: 'abc',
		};
		const open = vi
			.spyOn(GitHubAppPublisher.prototype, 'openChangeRequest')
			.mockResolvedValue(result);
		const update = vi
			.spyOn(GitHubAppPublisher.prototype, 'updateChangeRequest')
			.mockResolvedValue(result);
		const sources = registry(rule);
		const input = {
			repository: 'team/repo',
			baseBranch: 'main',
			baseCommit: 'abc',
			headBranch: 'change',
			title: 'Change',
			body: '',
			draft: true,
			changes: [],
		};
		const allowed = sources.getPublisher('github', projectId)!;
		await allowed.openChangeRequest(input);
		await allowed.updateChangeRequest!({ ...input, changeRequest: result });
		const denied = sources.getPublisher('github', ProjectId.parse('proj-1111111111111111'))!;
		await expect(denied.openChangeRequest(input)).rejects.toThrow('not allowed');
		await expect(denied.updateChangeRequest!({ ...input, changeRequest: result })).rejects.toThrow(
			'not allowed',
		);
		expect(open).toHaveBeenCalledOnce();
		expect(update).toHaveBeenCalledOnce();
	});
	it('supports explicit shared access, deny-all, and unknown providers', () => {
		expect(
			registry([{ resource: '*', projects: '*' }])
				.getReader('github')!
				.supportsRepository('team/repo'),
		).toBe(true);
		expect(() =>
			registry([]).getReader('github', projectId)!.supportsRepository('team/repo'),
		).toThrow('not allowed');
		expect(registry(rule).getPublisher('gitlab', projectId)).toBeUndefined();
		expect(registry(rule).getReader('gitlab', projectId)).toBeUndefined();
	});
	it('rejects non-GitHub repositories in policy configuration', () => {
		expect(() => registry([{ resource: 'https://gitlab.com/team/repo', projects: '*' }])).toThrow(
			'invalid GitHub repository',
		);
	});
});
