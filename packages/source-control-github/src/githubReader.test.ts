import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'fflate';
import { BadRequestError, UnavailableError, ValidationError } from '@marimo-hub/core/errors';
import { sourceControlPublishFailure } from '@marimo-hub/core/ports/source-control';
import { GitHubAppPublisher } from './index';
import { collectTarballWorkspace, tarballPathMapper } from './githubWorkspace';

const PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
	.privateKey.export({ type: 'pkcs8', format: 'pem' })
	.toString();

const encode = (s: string) => new TextEncoder().encode(s);

function response(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function tarEntry(name: string, body: Uint8Array, typeFlag = '0'): Uint8Array[] {
	const header = new Uint8Array(512);
	header.set(encode(name).subarray(0, 100), 0);
	header.set(encode(`${body.length.toString(8).padStart(11, '0')}\0`), 124);
	header[156] = typeFlag.charCodeAt(0);
	const padding = new Uint8Array((512 - (body.length % 512)) % 512);
	return [header, body, padding];
}

/** A gzipped tarball shaped like GitHub codeload output: one top-level dir. */
function tarball(files: Record<string, string>, extra: Uint8Array[] = []): Uint8Array<ArrayBuffer> {
	const chunks: Uint8Array[] = [];
	for (const [path, content] of Object.entries(files)) {
		chunks.push(...tarEntry(`repo-abc1234/${path}`, encode(content)));
	}
	chunks.push(...extra, new Uint8Array(1024));
	const total = chunks.reduce((sum, c) => sum + c.length, 0);
	const tar = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		tar.set(chunk, offset);
		offset += chunk.length;
	}
	const gz = gzipSync(tar);
	// Re-home into an ArrayBuffer-backed view so the result satisfies `BodyInit`.
	const body = new Uint8Array(gz.length);
	body.set(gz);
	return body;
}

function reader(
	routes: (url: URL, init?: RequestInit) => Response | null,
	access: 'read' | 'preview' = 'read',
) {
	const fetcher = async (input: string, init?: RequestInit) => {
		const url = new URL(input);
		if (url.pathname === '/repos/owner/repo/installation') return response({ id: 42 });
		if (url.pathname === '/app/installations/42/access_tokens') {
			expect(JSON.parse(String(init?.body))).toEqual({
				repositories: ['repo'],
				permissions:
					access === 'preview' ? { contents: 'read', pull_requests: 'read' } : { contents: 'read' },
			});
			return response({ token: 'installation-token' });
		}
		const matched = routes(url, init);
		if (!matched) throw new Error(`Unexpected GitHub request: ${url.pathname}`);
		return matched;
	};
	return new GitHubAppPublisher({ appId: '123', privateKey: PRIVATE_KEY }, { fetcher });
}

describe('GitHubAppPublisher reader', () => {
	it('bounds branch completion and rejects non-SHA commit references', async () => {
		const sha = 'a'.repeat(40);
		const github = reader((url) => {
			if (url.pathname === '/repos/owner/repo/branches') {
				expect(url.searchParams.get('per_page')).toBe('100');
				return response(
					Array.from({ length: 100 }, (_, i) => ({ name: `feature/${i}`, commit: { sha } })),
				);
			}
			if (url.pathname === `/repos/owner/repo/commits/${sha}`) return response({ sha });
			return null;
		});
		expect(await github.listBranches('owner/repo', 'feature/')).toHaveLength(30);
		expect(await github.resolveCommit('owner/repo', sha)).toEqual({ commit: sha });
		await expect(github.resolveCommit('owner/repo', 'main')).rejects.toThrow(ValidationError);
	});

	it.each([7, 39, 40])(
		'resolves a %i-character commit reference to its canonical SHA',
		async (length) => {
			const sha = 'abcdef0123456789abcdef0123456789abcdef0123';
			const ref = sha.slice(0, length);
			const github = reader((url) =>
				url.pathname === `/repos/owner/repo/commits/${ref}` ? response({ sha }) : null,
			);
			expect(await github.resolveCommit('owner/repo', ref)).toEqual({ commit: sha });
		},
	);

	it('matches recent commit subjects and returns canonical SHA values', async () => {
		const sha = 'a'.repeat(40);
		const github = reader((url) =>
			url.pathname === '/repos/owner/repo/commits'
				? response([{ sha, commit: { message: 'Chart prototype\nLong description' } }])
				: null,
		);
		expect(await github.listCommits('owner/repo', 'chart')).toEqual([
			{ value: sha, commit: sha, label: `${sha.slice(0, 12)} Chart prototype` },
		]);
	});

	it.each([13, 25, 39])(
		'matches %i-character SHA prefixes against the full commit',
		async (length) => {
			const sha = 'abcdef0123456789abcdef0123456789abcdef0123';
			const github = reader((url) =>
				url.pathname === '/repos/owner/repo/commits'
					? response([
							{ sha, commit: { message: 'Prototype' } },
							{ sha: 'b'.repeat(40), commit: { message: 'Unrelated' } },
						])
					: null,
			);
			expect(await github.listCommits('owner/repo', sha.slice(0, length).toUpperCase())).toEqual([
				{ value: sha, commit: sha, label: `${sha.slice(0, 12)} Prototype` },
			]);
		},
	);

	it('resolves a branch head', async () => {
		const github = reader((url) =>
			url.pathname === '/repos/owner/repo/branches/main'
				? response({ name: 'main', commit: { sha: 'headsha' } })
				: null,
		);
		await expect(github.getBranchHead('owner/repo', 'main')).resolves.toEqual({
			commit: 'headsha',
		});
	});

	it('URL-encodes branch segments while keeping their separators', async () => {
		const github = reader((url) =>
			url.pathname === '/repos/owner/repo/branches/feature/a%23b'
				? response({ commit: { sha: 'headsha' } })
				: null,
		);
		await expect(github.getBranchHead('owner/repo', 'feature/a#b')).resolves.toEqual({
			commit: 'headsha',
		});
	});

	it('rejects a missing branch as a validation error', async () => {
		const github = reader((url) =>
			url.pathname.startsWith('/repos/owner/repo/branches/') ? response({}, 404) : null,
		);
		await expect(github.getBranchHead('owner/repo', 'gone')).rejects.toThrow(ValidationError);
	});

	it('rejects invalid branch names without calling GitHub', async () => {
		const github = reader(() => null);
		await expect(github.getBranchHead('owner/repo', 'bad..branch')).rejects.toThrow(
			ValidationError,
		);
	});

	it('fetches the full tree when root path is empty, stripping the tarball prefix', async () => {
		const github = reader((url) =>
			url.pathname === '/repos/owner/repo/tarball/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
				? new Response(tarball({ 'app.py': 'print(1)', 'lib/util.py': 'print(2)' }))
				: null,
		);
		const files = await github.fetchWorkspace(
			'owner/repo',
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'',
		);
		expect(files.map((f) => f.path).sort()).toEqual(['app.py', 'lib/util.py']);
		expect(new TextDecoder().decode(files[0].bytes)).toBe('print(1)');
	});

	it('scopes the tree to the root path and skips symlinks', async () => {
		const symlink = tarEntry('repo-abc1234/apps/link.py', new Uint8Array(), '2');
		const github = reader((url) =>
			url.pathname.startsWith('/repos/owner/repo/tarball/')
				? new Response(tarball({ 'README.md': 'skip', 'apps/nb.py': 'print(1)' }, symlink))
				: null,
		);
		const files = await github.fetchWorkspace(
			'owner/repo',
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'apps',
		);
		expect(files.map((f) => f.path)).toEqual(['nb.py']);
	});

	it('rejects a commit that is not a SHA', async () => {
		const github = reader(() => null);
		await expect(github.fetchWorkspace('owner/repo', 'refs/heads/main', '')).rejects.toThrow(
			ValidationError,
		);
	});

	it('rejects an unsafe root path without calling GitHub', async () => {
		const github = reader(() => null);
		await expect(
			github.fetchWorkspace('owner/repo', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '../etc'),
		).rejects.toThrow(ValidationError);
	});

	it('surfaces a branch payload without a commit sha as unavailable', async () => {
		const github = reader((url) =>
			url.pathname === '/repos/owner/repo/branches/main'
				? response({ name: 'main', commit: {} })
				: null,
		);
		await expect(github.getBranchHead('owner/repo', 'main')).rejects.toThrow(UnavailableError);
	});

	it('surfaces a repository the App is not installed on as unavailable', async () => {
		const fetcher = async (input: string) => {
			const url = new URL(input);
			if (url.pathname === '/repos/owner/repo/installation') return response({}, 404);
			throw new Error(`Unexpected GitHub request: ${url.pathname}`);
		};
		const github = new GitHubAppPublisher({ appId: '123', privateKey: PRIVATE_KEY }, { fetcher });
		await expect(github.getBranchHead('owner/repo', 'main')).rejects.toThrow(
			/not installed for owner\/repo/,
		);
	});

	it('surfaces a failed tarball request as unavailable', async () => {
		const github = reader((url) =>
			url.pathname.startsWith('/repos/owner/repo/tarball/') ? response({}, 500) : null,
		);
		await expect(
			github.fetchWorkspace('owner/repo', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ''),
		).rejects.toThrow(UnavailableError);
	});

	it('surfaces an invalid tarball as a bad request', async () => {
		const github = reader((url) =>
			url.pathname.startsWith('/repos/owner/repo/tarball/')
				? new Response('this is not a gzip stream')
				: null,
		);
		await expect(
			github.fetchWorkspace('owner/repo', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ''),
		).rejects.toThrow(BadRequestError);
	});

	it('rejects an oversized file inside the root path but ignores one outside it', async () => {
		const oversized = 'x'.repeat(25 * 1024 * 1024 + 1);
		const archive = tarball({
			'apps/big.bin': oversized,
			'apps/notebook/nb.py': 'print(1)',
		});
		const inScope = reader((url) =>
			url.pathname.startsWith('/repos/owner/repo/tarball/') ? new Response(archive) : null,
		);
		await expect(
			inScope.fetchWorkspace('owner/repo', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'apps'),
		).rejects.toThrow(/exceeds the .*-byte limit/);

		const outOfScope = reader((url) =>
			url.pathname.startsWith('/repos/owner/repo/tarball/') ? new Response(archive) : null,
		);
		const files = await outOfScope.fetchWorkspace(
			'owner/repo',
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'apps/notebook',
		);
		expect(files.map((f) => f.path)).toEqual(['nb.py']);
	}, 10_000);

	it('syncs a small subtree from a monorepo whose full archive exceeds the ingest caps', async () => {
		// Six 20 MB files (120 MB inflated — past the 100 MB whole-archive cap,
		// each under the per-file cap) outside the root path, plus the subtree.
		const bulk = Object.fromEntries(
			Array.from({ length: 6 }, (_, i) => [`data/blob-${i}.bin`, '\0'.repeat(20 * 1024 * 1024)]),
		);
		const archive = tarball({ ...bulk, 'apps/nb.py': 'print(1)' });
		const scoped = reader((url) =>
			url.pathname.startsWith('/repos/owner/repo/tarball/') ? new Response(archive) : null,
		);
		const files = await scoped.fetchWorkspace(
			'owner/repo',
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'apps',
		);
		expect(files.map((f) => f.path)).toEqual(['nb.py']);

		// The same archive with everything selected still trips the total cap.
		const whole = reader((url) =>
			url.pathname.startsWith('/repos/owner/repo/tarball/') ? new Response(archive) : null,
		);
		await expect(
			whole.fetchWorkspace('owner/repo', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ''),
		).rejects.toThrow(/Decompressed archive exceeds the size limit/);
	}, 15_000);

	it('supports github.com repositories only', () => {
		const github = reader(() => null);
		expect(github.supportsRepository('owner/repo')).toBe(true);
		expect(github.supportsRepository('https://github.com/owner/repo')).toBe(true);
		expect(github.supportsRepository('https://github.mycompany.com/owner/repo')).toBe(false);
		expect(github.supportsRepository('https://gitlab.com/owner/repo')).toBe(false);
	});
});

describe('tarballPathMapper', () => {
	const strip = tarballPathMapper('');
	it('strips the top-level directory and drops bare top-level entries', () => {
		expect(strip('repo-sha/app.py')).toBe('app.py');
		expect(strip('pax_global_header')).toBeNull();
		expect(strip('repo-sha/')).toBeNull();
	});

	it('scopes to the root path', () => {
		const scoped = tarballPathMapper('apps/sub');
		expect(scoped('repo-sha/apps/sub/nb.py')).toBe('nb.py');
		expect(scoped('repo-sha/apps/other.py')).toBeNull();
		expect(scoped('repo-sha/apps/subdir/nb.py')).toBeNull();
	});
});

describe('collectTarballWorkspace', () => {
	const GZIP_HEADER = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0]);

	/** A non-final deflate stored block: 5-byte header + 64 KB of verbatim zeros. */
	function storedBlockChunk(): Uint8Array {
		const chunk = new Uint8Array(5 + 0xffff);
		chunk[1] = 0xff;
		chunk[2] = 0xff;
		return chunk;
	}

	it('aborts the download once the compressed size cap is exceeded', async () => {
		// Stored deflate blocks compress 1:1, so this valid gzip stream grows
		// without bound on the compressed side while inflating to harmless zeros.
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(pulls === 1 ? GZIP_HEADER : storedBlockChunk());
			},
		});
		await expect(collectTarballWorkspace(new Response(body), '')).rejects.toThrow(
			/tarball exceeds the size limit/,
		);
		expect(pulls).toBeLessThan(2000);
	});

	it('surfaces a mid-download stream failure as unavailable', async () => {
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls > 1) {
					controller.error(new Error('connection reset'));
					return;
				}
				controller.enqueue(Uint8Array.from(GZIP_HEADER));
			},
		});
		await expect(collectTarballWorkspace(new Response(body), '')).rejects.toThrow(UnavailableError);
	});

	it('surfaces a bodyless response as unavailable', async () => {
		await expect(collectTarballWorkspace(new Response(null), '')).rejects.toThrow(UnavailableError);
	});

	it('rejects a tarball that inflates beyond the work limit', async () => {
		// Zeros compress ~1000:1, so a tiny download can hide a huge inflation —
		// the inflated cap (injected small here) bounds the decompression work.
		const bomb = new Uint8Array(gzipSync(new Uint8Array(256 * 1024)));
		await expect(
			collectTarballWorkspace(new Response(bomb), 'apps', { maxInflatedBytes: 64 * 1024 }),
		).rejects.toThrow(/inflates beyond the size limit/);
	});

	it('rejects a stream cut before the end-of-archive marker', async () => {
		// gzip inflation reports nothing for a clean cut, so the tar trailer is
		// the only integrity signal — without this check a partial workspace
		// could ingest silently.
		await expect(
			collectTarballWorkspace(new Response(Uint8Array.from(GZIP_HEADER)), ''),
		).rejects.toThrow(/missing end-of-archive marker/);
	});
});

describe('GitHub preview source failures', () => {
	it.each([404, 422])(
		'rejects an unavailable pinned commit (%i) without exposing provider messages',
		async (status) => {
			const github = reader((url) =>
				url.pathname.includes('/commits/')
					? response({ message: 'provider-secret-must-not-leak' }, status)
					: null,
			);
			await expect(github.resolveCommit('owner/repo', 'a'.repeat(40))).rejects.toThrow(
				new ValidationError('Commit not found in the configured repository'),
			);
		},
	);

	it.each([404, 422])('returns no suggestions for a missing exact SHA (%i)', async (status) => {
		const github = reader((url) =>
			url.pathname.includes('/commits/') ? response({}, status) : null,
		);
		await expect(github.listCommits('owner/repo', 'a'.repeat(40))).resolves.toEqual([]);
	});

	it.each([403, 429, 503])('preserves exact-SHA discovery failures (%i)', async (status) => {
		const github = reader((url) =>
			url.pathname.includes('/commits/') ? response({}, status) : null,
		);
		await expect(github.listCommits('owner/repo', 'a'.repeat(40))).rejects.toThrow(
			UnavailableError,
		);
	});

	it('returns a matching exact SHA without searching recent commits', async () => {
		const sha = 'a'.repeat(40);
		const github = reader((url) =>
			url.pathname.endsWith(`/commits/${sha}`) ? response({ sha }) : null,
		);
		await expect(github.listCommits('owner/repo', sha)).resolves.toEqual([
			{ value: sha, commit: sha, label: sha.slice(0, 12) },
		]);
	});

	it.each([403, 429, 503])(
		'surfaces discovery HTTP %i instead of treating failure as an empty result',
		async (status) => {
			const github = reader((url) =>
				url.pathname.endsWith('/branches')
					? response({ message: 'provider-secret-must-not-leak' }, status)
					: null,
			);
			const result = github.listBranches('owner/repo', '');
			await expect(result).rejects.toThrow(UnavailableError);
			await expect(result).rejects.toMatchObject({
				message: `GitHub request failed with status ${status}`,
			});
		},
	);

	it.each([
		{ name: 'non-array branches', type: 'branch', payload: {} },
		{ name: 'branch missing name', type: 'branch', payload: [{ commit: { sha: 'a'.repeat(40) } }] },
		{ name: 'branch missing SHA', type: 'branch', payload: [{ name: 'main', commit: {} }] },
		{ name: 'non-array commits', type: 'commit', payload: null },
		{ name: 'commit missing SHA', type: 'commit', payload: [{ commit: { message: 'Message' } }] },
		{
			name: 'commit missing subject',
			type: 'commit',
			payload: [{ sha: 'a'.repeat(40), commit: {} }],
		},
	])('rejects malformed suggestions: $name', async ({ type, payload }) => {
		const github = reader((url) =>
			/\/(branches|commits)$/.test(url.pathname) ? response(payload) : null,
		);
		await expect(
			type === 'branch'
				? github.listBranches('owner/repo', '')
				: github.listCommits('owner/repo', ''),
		).rejects.toThrow(UnavailableError);
	});

	it.each([
		{ name: 'deleted head repository', repo: null, sameRepository: false },
		{ name: 'fork repository', repo: { full_name: 'contributor/fork' }, sameRepository: false },
		{
			name: 'repository with different casing',
			repo: { full_name: 'OWNER/Repo' },
			sameRepository: true,
		},
	])(
		'classifies a PR with a $name using read-only permissions',
		async ({ repo, sameRepository }) => {
			const github = reader(
				(url) =>
					url.pathname.endsWith('/pulls/42')
						? response({ state: 'open', head: { ref: 'feature/chart', sha: 'a'.repeat(40), repo } })
						: null,
				'preview',
			);
			await expect(github.getPullRequest('owner/repo', 42)).resolves.toEqual({
				number: 42,
				state: 'open',
				branch: 'feature/chart',
				commit: 'a'.repeat(40),
				sameRepository,
			});
		},
	);

	it.each([
		{ state: 'open', head: null },
		{
			state: 'merged',
			head: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: 'owner/repo' } },
		},
		{ state: 'open', head: { ref: 'main', repo: { full_name: 'owner/repo' } } },
	])('rejects malformed PR metadata: %j', async (payload) => {
		const github = reader(
			(url) => (url.pathname.endsWith('/pulls/42') ? response(payload) : null),
			'preview',
		);
		await expect(github.getPullRequest('owner/repo', 42)).rejects.toThrow(UnavailableError);
	});
});

describe('GitHub preview cancellation', () => {
	it('preserves a pre-flight cancellation without failure metadata or requests', async () => {
		const controller = new AbortController();
		const reason = new DOMException('Worker stopped', 'AbortError');
		controller.abort(reason);
		const fetcher = vi.fn();
		const github = new GitHubAppPublisher({ appId: '123', privateKey: PRIVATE_KEY }, { fetcher });
		await expect(
			github.getBranchHead('owner/repo', 'main', { signal: controller.signal }),
		).rejects.toBe(reason);
		expect(sourceControlPublishFailure(reason)).toBeUndefined();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each(['installation', 'access_tokens', 'branches/main'])(
		'preserves cancellation during %s without publication failure metadata',
		async (path) => {
			const controller = new AbortController();
			const reason = new DOMException('Worker stopped', 'AbortError');
			const fetcher = vi.fn(async (url: string) => {
				if (url.endsWith(`/${path}`)) {
					controller.abort(reason);
					throw new TypeError('Network request cancelled');
				}
				if (url.endsWith('/installation')) return response({ id: 42 });
				return response({ token: 'token' });
			});
			const github = new GitHubAppPublisher({ appId: '123', privateKey: PRIVATE_KEY }, { fetcher });
			await expect(
				github.getBranchHead('owner/repo', 'main', { signal: controller.signal }),
			).rejects.toBe(reason);
			expect(sourceControlPublishFailure(reason)).toBeUndefined();
		},
	);

	it.each(['installation', 'access_tokens', 'branches/main', 'tarball'])(
		'preserves cancellation while reading the %s response body',
		async (path) => {
			const controller = new AbortController();
			const reason = new DOMException('Worker stopped', 'AbortError');
			const fetcher = async (url: string) => {
				if (url.includes(`/${path}`)) {
					return new Response(
						new ReadableStream(
							{
								pull(stream) {
									controller.abort(reason);
									stream.error(new TypeError('Body cancelled'));
								},
							},
							{ highWaterMark: 0 },
						),
					);
				}
				if (url.endsWith('/installation')) return response({ id: 42 });
				return response({ token: 'token' });
			};
			const github = new GitHubAppPublisher({ appId: '123', privateKey: PRIVATE_KEY }, { fetcher });
			await expect(
				path === 'tarball'
					? github.fetchWorkspace('owner/repo', 'a'.repeat(40), '', { signal: controller.signal })
					: github.getBranchHead('owner/repo', 'main', { signal: controller.signal }),
			).rejects.toBe(reason);
			expect(sourceControlPublishFailure(reason)).toBeUndefined();
		},
	);

	it('passes the same cancellation signal through authentication and archive fetch', async () => {
		const controller = new AbortController();
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			expect(init?.signal).toBe(controller.signal);
			if (url.endsWith('/installation')) return response({ id: 42 });
			if (url.endsWith('/access_tokens')) return response({ token: 'token' });
			return new Response(tarball({ 'app.py': 'import marimo' }));
		});
		const github = new GitHubAppPublisher({ appId: '123', privateKey: PRIVATE_KEY }, { fetcher });
		await github.fetchWorkspace('owner/repo', 'a'.repeat(40), '', { signal: controller.signal });
		expect(fetcher).toHaveBeenCalledTimes(3);
	});

	it('does not continue authentication after cancellation', async () => {
		const controller = new AbortController();
		const fetcher = vi.fn(async () => {
			controller.abort();
			return response({ id: 42 });
		});
		const github = new GitHubAppPublisher({ appId: '123', privateKey: PRIVATE_KEY }, { fetcher });
		await expect(
			github.getBranchHead('owner/repo', 'main', { signal: controller.signal }),
		).rejects.toBe(controller.signal.reason);
		expect(sourceControlPublishFailure(controller.signal.reason)).toBeUndefined();
		expect(fetcher).toHaveBeenCalledOnce();
	});
});

describe('GitHub source suggestion cancellation', () => {
	const cases = [
		{ method: 'listBranches', query: '', path: '/branches?per_page=100', payload: [] },
		{ method: 'listCommits', query: '', path: '/commits?per_page=100', payload: [] },
		{
			method: 'listCommits',
			query: 'a'.repeat(40),
			path: `/commits/${'a'.repeat(40)}`,
			payload: { sha: 'a'.repeat(40) },
		},
	] as const;

	it.each(cases)(
		'passes cancellation through authentication and $path',
		async ({ method, query, payload }) => {
			const controller = new AbortController();
			const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
				expect(init?.signal).toBe(controller.signal);
				if (url.endsWith('/installation')) return response({ id: 42 });
				if (url.endsWith('/access_tokens')) return response({ token: 'token' });
				return response(payload);
			});
			const github = new GitHubAppPublisher({ appId: '123', privateKey: PRIVATE_KEY }, { fetcher });
			await github[method]('owner/repo', query, { signal: controller.signal });
			expect(fetcher).toHaveBeenCalledTimes(3);
		},
	);

	it.each(cases)(
		'preserves cancellation during the $path response body',
		async ({ method, query }) => {
			const controller = new AbortController();
			const reason = new DOMException('Discovery cancelled', 'AbortError');
			const fetcher = async (url: string) => {
				if (url.endsWith('/installation')) return response({ id: 42 });
				if (url.endsWith('/access_tokens')) return response({ token: 'token' });
				return new Response(
					new ReadableStream(
						{
							pull(stream) {
								controller.abort(reason);
								stream.error(new TypeError('Body cancelled'));
							},
						},
						{ highWaterMark: 0 },
					),
				);
			};
			const github = new GitHubAppPublisher({ appId: '123', privateKey: PRIVATE_KEY }, { fetcher });
			await expect(github[method]('owner/repo', query, { signal: controller.signal })).rejects.toBe(
				reason,
			);
		},
	);

	it.each(cases)(
		'stops pre-aborted $path discovery before authentication',
		async ({ method, query }) => {
			const controller = new AbortController();
			controller.abort();
			const fetcher = vi.fn();
			const github = new GitHubAppPublisher({ appId: '123', privateKey: PRIVATE_KEY }, { fetcher });
			await expect(github[method]('owner/repo', query, { signal: controller.signal })).rejects.toBe(
				controller.signal.reason,
			);
			expect(fetcher).not.toHaveBeenCalled();
		},
	);
});
