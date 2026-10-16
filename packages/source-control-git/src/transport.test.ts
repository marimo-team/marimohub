import { describe, expect, it, vi } from 'vitest';
import { BadRequestError, UnavailableError } from '@marimo-hub/core/errors';
import { materializeGitDirectory } from './index';
import { DEFAULT_GIT_TRANSPORT_TIMEOUTS, PUSH_GIT_TRANSPORT_TIMEOUTS, gitHttp } from './transport';
import type { GitFetch } from './transport';

const remoteUrl = 'https://gitlab.com/team/project.git';
const timeouts = { headersMs: 50, idleMs: 50 };

function client(fetcher: GitFetch, signal?: AbortSignal) {
	return gitHttp({ fetcher, repository: 'team/project', remoteUrl, signal, timeouts });
}

async function drain(body: AsyncIterableIterator<Uint8Array> | undefined): Promise<number> {
	let size = 0;
	for await (const chunk of body ?? []) size += chunk.byteLength;
	return size;
}

function stalledStream(cancel = vi.fn()) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]));
		},
		cancel,
	});
}

describe('Git transport guard', () => {
	it.each([
		'https://evil.test/team/project.git/info/refs',
		'http://gitlab.com/team/project.git/info/refs',
		'https://gitlab.com/team/other.git/info/refs',
		'https://gitlab.com/team/project.git.evil/info/refs',
		'https://user:secret@gitlab.com/team/project.git/info/refs',
	])('never sends a request to %s', async (url) => {
		const fetcher = vi.fn<GitFetch>();
		await expect(
			client(fetcher).request({ url, method: 'GET', headers: {} }),
		).rejects.toBeInstanceOf(BadRequestError);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('refuses redirects', async () => {
		const fetcher = vi.fn<GitFetch>(async (_url, init) => {
			expect(init?.redirect).toBe('error');
			return new Response(null, {
				status: 302,
				headers: { location: 'https://evil.test/team/project.git/info/refs' },
			});
		});
		const error = await client(fetcher)
			.request({
				url: `${remoteUrl}/info/refs?service=git-upload-pack`,
				method: 'GET',
				headers: {},
			})
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(UnavailableError);
		expect(error).toMatchObject({ providerStatus: 302 });
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it('times out waiting for response headers', async () => {
		let transportSignal: AbortSignal | null | undefined;
		const fetcher: GitFetch = (_url, init) => {
			transportSignal = init?.signal;
			return new Promise(() => {});
		};
		await expect(
			client(fetcher).request({ url: `${remoteUrl}/git-upload-pack`, method: 'POST', headers: {} }),
		).rejects.toThrow(new UnavailableError('Git server did not respond in time'));
		expect(transportSignal?.aborted).toBe(true);
	});

	it('gives pushes five minutes to upload the pack and receive headers', async () => {
		vi.useFakeTimers();
		try {
			let transportSignal: AbortSignal | null | undefined;
			const fetcher: GitFetch = (_url, init) => {
				transportSignal = init?.signal;
				return new Promise(() => {});
			};
			const request = gitHttp({
				fetcher,
				repository: 'team/project',
				remoteUrl,
				timeouts: PUSH_GIT_TRANSPORT_TIMEOUTS,
			}).request({ url: `${remoteUrl}/git-receive-pack`, method: 'POST', headers: {} });
			const rejection = expect(request).rejects.toThrow(
				new UnavailableError('Git server did not respond in time'),
			);
			await vi.advanceTimersByTimeAsync(DEFAULT_GIT_TRANSPORT_TIMEOUTS.headersMs);
			expect(transportSignal?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(300_000 - DEFAULT_GIT_TRANSPORT_TIMEOUTS.headersMs);
			expect(transportSignal?.aborted).toBe(true);
			await rejection;
		} finally {
			vi.useRealTimers();
		}
	});

	it('times out a stalled body and cancels its stream', async () => {
		const cancel = vi.fn();
		const response = await client(async () => new Response(stalledStream(cancel))).request({
			url: `${remoteUrl}/git-upload-pack`,
			method: 'POST',
			headers: {},
		});
		await expect(drain(response.body)).rejects.toThrow(
			new UnavailableError('Git server stopped sending data'),
		);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('lets a slow body that keeps progressing finish past the idle timeout', async () => {
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				if (sent++ === 5) controller.close();
				else controller.enqueue(new Uint8Array(10));
			},
		});
		const response = await client(async () => new Response(body)).request({
			url: `${remoteUrl}/git-upload-pack`,
			method: 'POST',
			headers: {},
		});
		expect(await drain(response.body)).toBe(50);
	});

	it('propagates caller cancellation into the body', async () => {
		const caller = new AbortController();
		const reason = new Error('Canceled by caller');
		const response = await gitHttp({
			fetcher: async () => new Response(stalledStream()),
			repository: 'team/project',
			remoteUrl,
			signal: caller.signal,
		}).request({ url: `${remoteUrl}/git-upload-pack`, method: 'POST', headers: {} });
		const pending = drain(response.body);
		caller.abort(reason);
		await expect(pending).rejects.toBe(reason);
	});

	it('surfaces caller cancellation from materialization unchanged', async () => {
		const caller = new AbortController();
		const reason = new Error('Canceled by caller');
		const pending = materializeGitDirectory({
			repository: 'team/project',
			remoteUrl,
			commit: 'a'.repeat(40),
			branch: 'main',
			authorization: 'Bearer token',
			signal: caller.signal,
			fetcher: () => new Promise(() => {}),
		});
		caller.abort(reason);
		await expect(pending).rejects.toBe(reason);
	});

	it('reports a stalled fetch as unavailable', async () => {
		await expect(
			materializeGitDirectory({
				repository: 'team/project',
				remoteUrl,
				commit: 'a'.repeat(40),
				branch: 'main',
				authorization: 'Bearer token',
				timeouts,
				fetcher: async () => new Response(stalledStream()),
			}),
		).rejects.toThrow(new UnavailableError('Git server stopped sending data'));
	});
});
