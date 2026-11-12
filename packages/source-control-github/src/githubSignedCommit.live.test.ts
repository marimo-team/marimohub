import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type { SignedPreparation } from '@marimo-hub/core/source-control-publication';
import { GitHubAccountProvider } from './githubAccount';
import { GitHubAppPublisher } from './index';
import { GitHubUserPublisher } from './githubUserPublisher';

// Opt-in writes only a random temporary preparation branch in the disposable repository.
// Credential files must contain a GitHub App user access token and that App's PEM private key.
it.skipIf(process.env.MARIMOHUB_GITHUB_SIGNING_SMOKE !== '1')(
	'prepares and verifies a live personal GitHub commit',
	async () => {
		const required = (key: string) => {
			const value = process.env[key];
			if (!value) throw new Error(`Set ${key} for the live signing probe`);
			return value;
		};
		const repository = required('MARIMOHUB_GITHUB_SIGNING_SMOKE_REPOSITORY');
		const token = (
			await readFile(required('MARIMOHUB_GITHUB_SIGNING_SMOKE_USER_TOKEN_FILE'), 'utf8')
		).trim();
		const options = {
			appId: required('MARIMOHUB_SOURCE_CONTROL_GITHUB_APP_ID'),
			privateKey: await readFile(required('MARIMOHUB_GITHUB_SIGNING_SMOKE_APP_KEY_FILE'), 'utf8'),
		};
		const identity = await new GitHubAccountProvider('', '').identity(token);
		const app = new GitHubAppPublisher(options);
		const parent = await app.getBranchHead(
			repository,
			required('MARIMOHUB_GITHUB_SIGNING_SMOKE_BASE_BRANCH'),
		);
		const publisher = new GitHubUserPublisher(options, {
			accountId: identity.id,
			token: async () => token,
		});
		let preparation: SignedPreparation | undefined;
		try {
			const result = await publisher.workingBranches.prepareCommit({
				repository,
				parentCommit: parent.commit,
				message: 'marimohub signing smoke test',
				changes: [
					{
						path: `.marimohub-signing-smoke-${crypto.randomUUID()}.txt`,
						operation: 'add',
						content: new TextEncoder().encode('Disposable signing probe\n'),
					},
				],
				preparation: {
					read: async () => preparation,
					write: async (value) => {
						preparation = value;
					},
				},
			});
			expect(result.commit).toMatch(/^[a-f0-9]{40,64}$/);
			expect(preparation?.cleaned).toBe(true);
		} finally {
			if (preparation && !preparation.cleaned)
				await app.cleanupPreparation({ repository, preparation });
		}
	},
	120_000,
);
