import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { UnavailableError, ValidationError } from '@marimo-hub/core/errors';
import { sourceControlPublishFailure } from '@marimo-hub/core/ports/source-control';
import { GitHubClient } from './githubClient';
import type { GitHubFetch } from './githubClient';
import { GitHubAppPublisher } from './index';

const origin = 'https://git.acme.corp:8443';
const options = {
	appId: '123',
	privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 })
		.privateKey.export({ type: 'pkcs8', format: 'pem' })
		.toString(),
	url: origin,
};
const archivePath = '/repos/owner/repo/tarball/abc1234';
const archiveUrl = `${origin}/_codeload/owner/repo/archive`;

function client(fetcher: GitHubFetch) {
	return new GitHubClient(options, { fetcher });
}

function redirect(location: string, status = 302): Response {
	return new Response(null, { status, headers: { location } });
}

describe('GitHub archive redirects', () => {
	it.each([301, 302, 303, 307, 308])(
		'follows status %s and cancels the redirect body',
		async (status) => {
			const cancel = vi.fn();
			const archive = new Response('archive');
			const fetcher = vi
				.fn<GitHubFetch>()
				.mockResolvedValueOnce(
					new Response(new ReadableStream({ cancel }), {
						status,
						headers: { location: archiveUrl },
					}),
				)
				.mockResolvedValueOnce(archive);
			await expect(client(fetcher).tarball(archivePath, 'token')).resolves.toBe(archive);
			expect(cancel).toHaveBeenCalledOnce();
			expect(fetcher).toHaveBeenLastCalledWith(archiveUrl, {
				redirect: 'manual',
				headers: { authorization: 'Bearer token' },
			});
		},
	);

	it.each([undefined, '', 'https://[invalid'])(
		'rejects missing or malformed Location %s without another request',
		async (location) => {
			const cancel = vi.fn();
			const fetcher = vi.fn<GitHubFetch>().mockResolvedValue(
				new Response(new ReadableStream({ cancel }), {
					status: 302,
					headers: location === undefined ? {} : { location },
				}),
			);
			await expect(client(fetcher).tarball(archivePath, 'token')).rejects.toThrow(
				'Invalid GitHub archive redirect',
			);
			expect(fetcher).toHaveBeenCalledOnce();
			expect(cancel).toHaveBeenCalledOnce();
		},
	);

	it.each([
		'https://git.acme.corp/archive',
		'https://git.acme.corp.evil.example:8443/archive',
		'https://codeload.git.acme.corp.evil.example:8443/archive',
		'https://codeload.git.acme.corp/archive',
		'https://git.acme.corp:8443/archive#fragment',
		'//evil.example/archive',
	])('rejects a misleading host, wrong port, or fragment: %s', async (location) => {
		const fetcher = vi.fn<GitHubFetch>().mockResolvedValue(redirect(location));
		await expect(client(fetcher).tarball(archivePath, 'token')).rejects.toThrow(
			'Unexpected GitHub archive redirect',
		);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('resolves relative redirects against the preceding codeload URL and keeps credentials stripped', async () => {
		const codeload = 'https://codeload.git.acme.corp:8443/owner/repo/start';
		const fetcher = vi
			.fn<GitHubFetch>()
			.mockResolvedValueOnce(redirect(codeload))
			.mockResolvedValueOnce(redirect('../archive?signature=abc', 307))
			.mockResolvedValueOnce(new Response('archive'));
		await expect(client(fetcher).tarball(archivePath, 'token')).resolves.toBeInstanceOf(Response);
		expect(fetcher).toHaveBeenNthCalledWith(2, codeload, { redirect: 'manual', headers: {} });
		expect(fetcher).toHaveBeenNthCalledWith(
			3,
			'https://codeload.git.acme.corp:8443/owner/archive?signature=abc',
			{ redirect: 'manual', headers: {} },
		);
	});

	it('checks every redirect hop before making another request', async () => {
		const fetcher = vi
			.fn<GitHubFetch>()
			.mockResolvedValueOnce(redirect(archiveUrl))
			.mockResolvedValueOnce(redirect('https://evil.example/archive'));
		await expect(client(fetcher).tarball(archivePath, 'token')).rejects.toThrow(
			'Unexpected GitHub archive redirect',
		);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it.each([401, 403, 404, 429, 500])(
		'surfaces a download status of %s as unavailable',
		async (status) => {
			const fetcher = vi
				.fn<GitHubFetch>()
				.mockResolvedValueOnce(redirect(archiveUrl))
				.mockResolvedValueOnce(
					new Response('provider response with sensitive details', { status }),
				);
			await expect(client(fetcher).tarball(archivePath, 'token')).rejects.toThrow(
				`GitHub request failed with status ${status}`,
			);
			expect(fetcher).toHaveBeenCalledTimes(2);
		},
	);

	it('surfaces a TLS or network failure after redirect without exposing provider details', async () => {
		const fetcher = vi
			.fn<GitHubFetch>()
			.mockResolvedValueOnce(redirect(archiveUrl))
			.mockRejectedValueOnce(
				new Error('certificate verification failed; private endpoint details'),
			);
		await expect(client(fetcher).tarball(archivePath, 'token')).rejects.toMatchObject({
			message: 'GitHub archive is unavailable',
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});

describe('GitHub Enterprise failure boundaries', () => {
	const input = {
		repository: `${origin}/owner/repo`,
		baseBranch: 'main',
		baseCommit: 'base-sha',
		headBranch: 'proposal',
		title: 'Update',
		body: '',
		draft: true,
		changes: [{ operation: 'add' as const, path: 'app.py', content: new Uint8Array([1]) }],
	};
	const changeRequest = {
		number: 17,
		url: `${origin}/owner/repo/pull/17`,
		headBranch: 'proposal',
		headCommit: 'head-sha',
	};

	it.each([
		'owner/repo',
		'https://github.com/owner/repo',
		'https://git.acme.corp/owner/repo',
		'https://git.acme.corp.evil.example:8443/owner/repo',
		`${origin}/owner/repo?token=secret`,
		'https://user:secret@git.acme.corp:8443/owner/repo',
		`${origin}/owner/repo#fragment`,
	])('rejects publication to %s before requesting credentials', async (repository) => {
		const fetcher = vi.fn<GitHubFetch>();
		const github = new GitHubAppPublisher(options, { fetcher });
		await expect(github.openChangeRequest({ ...input, repository })).rejects.toThrow(
			ValidationError,
		);
		await expect(
			github.updateChangeRequest({ ...input, repository, changeRequest }),
		).rejects.toThrow(ValidationError);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each([
		['installation', 404],
		['installation', 403],
		['auth', 401],
		['auth', 429],
	] as const)(
		'stops publication on %s failure %s and preserves failure metadata',
		async (stage, status) => {
			const fetcher = vi.fn<GitHubFetch>(async (url) => {
				expect(url.startsWith(`${origin}/api/v3/`)).toBe(true);
				if (stage === 'auth' && url.endsWith('/installation')) return Response.json({ id: 42 });
				return new Response('private provider details', { status });
			});
			const github = new GitHubAppPublisher(options, { fetcher });
			const failure = await github.openChangeRequest(input).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(UnavailableError);
			expect(sourceControlPublishFailure(failure)).toMatchObject({
				provider: 'github',
				stage,
				status,
			});
			expect((failure as Error).message).not.toContain('private provider details');
			expect(fetcher).toHaveBeenCalledTimes(stage === 'auth' ? 2 : 1);
		},
	);
});
