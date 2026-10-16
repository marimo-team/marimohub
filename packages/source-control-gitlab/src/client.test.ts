import { describe, expect, it, vi } from 'vitest';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	UnavailableError,
} from '@marimo-hub/core/errors';
import { GitLabClient } from './client';
import { gitLabOrigin, parseGitLabRepository } from './repository';
import { list } from './trees';

const repository = 'https://gitlab.com/team/subgroup/project';
const repo = parseGitLabRepository(repository);

describe('GitLab repository boundaries', () => {
	it('encodes nested project paths once and supports a configured HTTPS origin', () => {
		expect(parseGitLabRepository(`${repository}.git/`)).toMatchObject({
			url: repository,
			path: 'team/subgroup/project',
			apiUrl: 'https://gitlab.com/api/v4/projects/team%2Fsubgroup%2Fproject',
		});
		expect(
			parseGitLabRepository(
				'https://code.example.com:8443/Group/Sub/Project',
				'https://code.example.com:8443',
			).url,
		).toBe('https://code.example.com:8443/Group/Sub/Project');
	});
	it.each([
		'http://gitlab.com/team/project',
		'https://gitlab.com.evil.test/team/project',
		'https://user:secret@gitlab.com/team/project',
		`${repository}?x=1`,
		`${repository}#x`,
		'https://gitlab.com/team/a%2Fb',
		'https://gitlab.com/team/%2e%2e/project',
		'https://gitlab.com/team/../project',
		'https://gitlab.com/team/a%5Cb',
		'https://gitlab.com/team/%ZZ',
		'https://gitlab.com/project',
		'git@gitlab.com:team/project.git',
	])('rejects unsafe repository %s', (value) => {
		expect(() => parseGitLabRepository(value)).toThrow();
	});
	it.each([
		'http://code.example.com',
		'https://user:secret@code.example.com',
		'https://code.example.com/path',
		'https://code.example.com/..',
		'https://code.example.com?x=1',
		'https://code.example.com#x',
	])('rejects unsafe origin %s', (value) => {
		expect(() => gitLabOrigin(value)).toThrow();
	});
});

describe('GitLab HTTP boundaries', () => {
	it('does not expose provider response bodies, tokens, or fetch errors', async () => {
		const client = new GitLabClient(
			{ token: 'secret' },
			{
				fetcher: async () => {
					throw new Error('secret');
				},
			},
		);
		await expect(client.json(repo, '/repository/tree')).rejects.toThrow('GitLab is unavailable');
	});
	it('rejects malformed JSON', async () => {
		const client = new GitLabClient(
			{ token: 'secret' },
			{ fetcher: async () => new Response('not JSON') },
		);
		await expect(client.json(repo, '/repository/tree')).rejects.toThrow('Invalid GitLab JSON');
	});
	it('reads all pages without following provider-supplied URLs', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json([{ id: 1 }], { headers: { 'x-next-page': '2' } }))
			.mockResolvedValueOnce(Response.json([{ id: 2 }], { headers: { 'x-next-page': '' } }));
		const client = new GitLabClient({ token: 'secret' }, { fetcher });
		expect(await list(client, repo, '/repository/tree', {})).toEqual([{ id: 1 }, { id: 2 }]);
		expect(fetcher.mock.calls[1][0]).toContain('page=2');
	});
	it.each(['1', '3', 'https://evil.test'])('rejects malformed pagination %s', async (next) => {
		const client = new GitLabClient(
			{ token: 'secret' },
			{ fetcher: async () => Response.json([{}], { headers: { 'x-next-page': next } }) },
		);
		await expect(list(client, repo, '/repository/tree', {})).rejects.toThrow('pagination');
	});
	it('caps pagination entries', async () => {
		const fetcher = vi.fn(async (url: string) =>
			Response.json(
				Array.from({ length: 100 }, () => ({})),
				{ headers: { 'x-next-page': String(Number(new URL(url).searchParams.get('page')) + 1) } },
			),
		);
		await expect(
			list(new GitLabClient({ token: 'secret' }, { fetcher }), repo, '/repository/tree', {}),
		).rejects.toThrow('too many entries');
		expect(fetcher).toHaveBeenCalledTimes(21);
	});
	it.each([0, 1])('caps endless pagination with %s entries per page', async (count) => {
		const fetcher = vi.fn(async (url: string) =>
			Response.json(
				Array.from({ length: count }, () => ({})),
				{ headers: { 'x-next-page': String(Number(new URL(url).searchParams.get('page')) + 1) } },
			),
		);
		await expect(
			list(new GitLabClient({ token: 'secret' }, { fetcher }), repo, '/repository/tree', {}),
		).rejects.toThrow('too many pages');
		expect(fetcher).toHaveBeenCalledTimes(21);
	});
});

describe('GitLab request failures', () => {
	it('does not issue a request when the caller has already canceled', async () => {
		const fetcher = vi.fn(async () => Response.json({}));
		const client = new GitLabClient({ token: 'secret' }, { fetcher });
		const controller = new AbortController();
		const reason = new Error('Canceled by caller');
		controller.abort(reason);
		await expect(
			client.json(repo, '/repository/tree', {}, { signal: controller.signal }),
		).rejects.toBe(reason);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('propagates cancellation even when the transport ignores it', async () => {
		const fetcher = vi.fn(() => new Promise<Response>(() => {}));
		const client = new GitLabClient({ token: 'secret' }, { fetcher });
		const controller = new AbortController();
		const pending = client.json(repo, '/repository/tree', {}, { signal: controller.signal });
		const reason = new Error('Canceled by caller');
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
	});
	it.each([401, 403, 404, 409, 429, 503])(
		'cancels HTTP %s bodies and preserves status without leaking content',
		async (status) => {
			const cancel = vi.fn();
			const client = new GitLabClient(
				{ token: 'secret' },
				{
					fetcher: async () =>
						new Response(
							new ReadableStream({
								start(controller) {
									controller.enqueue(new TextEncoder().encode('secret provider details'));
								},
								cancel,
							}),
							{ status },
						),
				},
			);
			const error = await client.json(repo, '/repository/tree').catch((error: unknown) => error);
			expect(error).toMatchObject({ providerStatus: status });
			expect(String(error)).not.toContain('secret');
			expect(cancel).toHaveBeenCalledOnce();
		},
	);
	it.each([
		{ status: 400, type: BadRequestError },
		{ status: 401, type: ForbiddenError },
		{ status: 404, type: NotFoundError },
		{ status: 409, type: ConflictError },
		{ status: 412, type: ConflictError },
		{ status: 429, type: UnavailableError },
		{ status: 503, type: UnavailableError },
	])('maps HTTP $status to a domain error', async ({ status, type }) => {
		const client = new GitLabClient(
			{ token: 'secret' },
			{
				fetcher: async () => new Response(null, { status, headers: { 'retry-after': '7' } }),
			},
		);
		const error = await client.json(repo, '/repository/tree').catch((error: unknown) => error);
		expect(error).toBeInstanceOf(type);
		if (status === 429) expect(error).toMatchObject({ retryAfterSeconds: 7 });
	});
	it('sanitizes body-stream failures while preserving their cause', async () => {
		const cause = new Error('secret transport details');
		const client = new GitLabClient(
			{ token: 'secret' },
			{
				fetcher: async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.error(cause);
							},
						}),
					),
			},
		);
		const error = await client.data(repo, '/repository/tree').catch((error: unknown) => error);
		expect(error).toMatchObject({ message: 'GitLab response could not be read', cause });
		expect(String(error)).not.toContain('secret transport details');
	});
	it('continues a full page when pagination headers are missing', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json(Array.from({ length: 100 }, (_, id) => ({ id }))))
			.mockResolvedValueOnce(Response.json([{ id: 100 }]));
		expect(
			await list(new GitLabClient({ token: 'secret' }, { fetcher }), repo, '/repository/tree', {}),
		).toHaveLength(101);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it.each([{}, null, 'not a list'])('rejects a malformed list response: %j', async (value) => {
		const client = new GitLabClient(
			{ token: 'secret' },
			{ fetcher: async () => Response.json(value) },
		);
		await expect(list(client, repo, '/repository/tree', {})).rejects.toThrow('Invalid GitLab list');
	});
});
