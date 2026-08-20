import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { BadRequestError, UnavailableError, ValidationError } from '@marimo-hub/core';
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

function reader(routes: (url: URL, init?: RequestInit) => Response | null) {
	const fetcher = async (input: string, init?: RequestInit) => {
		const url = new URL(input);
		if (url.pathname === '/repos/owner/repo/installation') return response({ id: 42 });
		if (url.pathname === '/app/installations/42/access_tokens') {
			return response({ token: 'installation-token' });
		}
		const matched = routes(url, init);
		if (!matched) throw new Error(`Unexpected GitHub request: ${url.pathname}`);
		return matched;
	};
	return new GitHubAppPublisher({ appId: '123', privateKey: PRIVATE_KEY }, { fetcher });
}

describe('GitHubAppPublisher reader', () => {
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
		const inScope = reader((url) =>
			url.pathname.startsWith('/repos/owner/repo/tarball/')
				? new Response(tarball({ 'apps/big.bin': oversized, 'apps/nb.py': 'print(1)' }))
				: null,
		);
		await expect(
			inScope.fetchWorkspace('owner/repo', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'apps'),
		).rejects.toThrow(/exceeds the .*-byte limit/);

		const outOfScope = reader((url) =>
			url.pathname.startsWith('/repos/owner/repo/tarball/')
				? new Response(tarball({ 'big.bin': oversized, 'apps/nb.py': 'print(1)' }))
				: null,
		);
		const files = await outOfScope.fetchWorkspace(
			'owner/repo',
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'apps',
		);
		expect(files.map((f) => f.path)).toEqual(['nb.py']);
	});

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
	});

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

	it('rejects a stream cut before the end-of-archive marker', async () => {
		// gzip inflation reports nothing for a clean cut, so the tar trailer is
		// the only integrity signal — without this check a partial workspace
		// could ingest silently.
		await expect(
			collectTarballWorkspace(new Response(Uint8Array.from(GZIP_HEADER)), ''),
		).rejects.toThrow(/Truncated repository tarball/);
	});
});
