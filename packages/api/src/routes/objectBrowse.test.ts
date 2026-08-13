import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Millis, ObjectBrowseError, ResourceExhaustedError, UserId } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import type { ObjectBody, Project, TempS3Creds } from '@marimo-hub/core';
import {
	acquireDownload,
	clearObjectCredentialCacheForTests,
	makeObjectBrowseContext,
	objectContentDisposition,
	runObjectBrowse,
	safeObjectContentType,
	streamObjectBody,
	validRangeHeader,
} from './objectBrowse';

const project = {
	id: 'proj-01J00000000000000000000000',
	federation: { enabled: true },
} as Project;
const user = { id: UserId.parse('user-object-test'), email: 'object@example.com' };

beforeEach(() => clearObjectCredentialCacheForTests());

function wifDeps(exchange: () => Promise<TempS3Creds>): ApiDeps {
	return {
		wif: {
			issuer: { mint: vi.fn(async () => 'jwt') } as never,
			issuerUrl: 'https://hub.example.com',
			target: {
				audience: 'storage',
				storage: { endpoint: 'https://s3.example.com', region: 'us-east-1' },
				broker: { exchange },
			},
		},
		dataBrowser: {
			preview: true,
			objectBrowser: {
				allowServerAmbientCredentials: false,
				maxConcurrentDownloads: 1,
				maxConcurrentDownloadsPerUser: 1,
				downloadTimeoutMs: Millis.of(60_000),
			},
		},
	} as unknown as ApiDeps;
}

describe('object browse credentials', () => {
	it('single-flights and caches credentials with a usable expiry', async () => {
		const exchange = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return {
				accessKeyId: 'temporary',
				secretAccessKey: 'secret',
				expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			};
		});
		const deps = wifDeps(exchange);
		const contexts = await Promise.all([
			makeObjectBrowseContext(deps, project, user, undefined, { integrationId: 'a' }),
			makeObjectBrowseContext(deps, project, user, undefined, { integrationId: 'a' }),
		]);
		expect(
			contexts.every((context) => context.temporary_s3_credentials?.accessKeyId === 'temporary'),
		).toBe(true);
		await makeObjectBrowseContext(deps, project, user, undefined, { integrationId: 'a' });
		expect(exchange).toHaveBeenCalledTimes(1);
	});

	it('does not cache credentials without a valid expiry or across integrations', async () => {
		const exchange = vi.fn<() => Promise<TempS3Creds>>(async () => ({
			accessKeyId: 'temporary',
			secretAccessKey: 'secret',
		}));
		const deps = wifDeps(exchange);
		await makeObjectBrowseContext(deps, project, user, undefined, { integrationId: 'a' });
		await makeObjectBrowseContext(deps, project, user, undefined, { integrationId: 'a' });
		expect(exchange).toHaveBeenCalledTimes(2);

		exchange.mockResolvedValue({
			accessKeyId: 'temporary',
			secretAccessKey: 'secret',
			expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		});
		await makeObjectBrowseContext(deps, project, user, undefined, { integrationId: 'b' });
		await makeObjectBrowseContext(deps, project, user, undefined, { integrationId: 'c' });
		expect(exchange).toHaveBeenCalledTimes(4);
	});

	it('refreshes credentials that expire inside the five-minute safety window', async () => {
		const exchange = vi.fn(async () => ({
			accessKeyId: 'temporary',
			secretAccessKey: 'secret',
			expiration: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
		}));
		const deps = wifDeps(exchange);
		await makeObjectBrowseContext(deps, project, user, undefined, { integrationId: 'a' });
		await makeObjectBrowseContext(deps, project, user, undefined, { integrationId: 'a' });
		expect(exchange).toHaveBeenCalledTimes(2);
	});

	it('bounds the credential cache and evicts the oldest integration', async () => {
		const exchange = vi.fn(async () => ({
			accessKeyId: 'temporary',
			secretAccessKey: 'secret',
			expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		}));
		const deps = wifDeps(exchange);
		for (let index = 0; index < 257; index += 1) {
			await makeObjectBrowseContext(deps, project, user, undefined, {
				integrationId: `integration-${index}`,
			});
		}
		await makeObjectBrowseContext(deps, project, user, undefined, {
			integrationId: 'integration-0',
		});
		expect(exchange).toHaveBeenCalledTimes(258);
	});

	it('can suppress federation and safely falls back when an exchange fails', async () => {
		const exchange = vi.fn(async (): Promise<TempS3Creds> => {
			throw new Error('broker-secret');
		});
		const deps = wifDeps(exchange);
		deps.dataBrowser!.objectBrowser!.allowServerAmbientCredentials = true;
		const withoutWif = await makeObjectBrowseContext(deps, project, user, undefined, {
			includeFederated: false,
			allowServerAmbient: true,
		});
		expect(withoutWif).toMatchObject({ allow_server_ambient: true });
		expect(exchange).not.toHaveBeenCalled();

		const failed = await makeObjectBrowseContext(deps, project, user);
		expect(failed.temporary_s3_credentials).toBeUndefined();
		expect(failed.allow_server_ambient).toBe(false);
		expect(exchange).toHaveBeenCalledTimes(1);
	});

	it('does not mint credentials for a project without federation enabled', async () => {
		const exchange = vi.fn(async () => ({
			accessKeyId: 'temporary',
			secretAccessKey: 'secret',
		}));
		const signal = new AbortController().signal;
		const context = await makeObjectBrowseContext(
			wifDeps(exchange),
			{ ...project, federation: { enabled: false } },
			user,
			signal,
		);
		expect(context).toMatchObject({
			allow_server_ambient: false,
			project_id: project.id,
			signal,
		});
		expect(context.temporary_s3_credentials).toBeUndefined();
		expect(exchange).not.toHaveBeenCalled();
	});
});

describe('object error mapping', () => {
	it.each([
		['access_denied', 'ForbiddenError'],
		['not_found', 'NotFoundError'],
		['precondition_failed', 'PreconditionFailedError'],
		['invalid_cursor', 'ValidationError'],
		['unsupported', 'ValidationError'],
		['aborted', 'UnavailableError'],
		['unavailable', 'UnavailableError'],
	] as const)('maps %s into a safe domain error', async (code, name) => {
		await expect(
			runObjectBrowse(async () => {
				throw new ObjectBrowseError(code, 'safe message');
			}),
		).rejects.toMatchObject({ name, message: 'safe message' });
	});

	it('maps invalid ranges to 416 and preserves unrelated errors', async () => {
		await expect(
			runObjectBrowse(async () => {
				throw new ObjectBrowseError('range_not_satisfiable', 'bad range');
			}),
		).rejects.toMatchObject({ status: 416, message: 'bad range' });
		const unrelated = new Error('unrelated');
		await expect(
			runObjectBrowse(async () => {
				throw unrelated;
			}),
		).rejects.toBe(unrelated);
	});
});

describe('object content response helpers', () => {
	it('sanitizes fallback filenames while preserving a UTF-8 filename', () => {
		const value = objectContentDisposition('reports/日本語\r\n";%.csv', false);
		expect(value).toMatch(/^attachment; filename="[^"]+"; filename\*=UTF-8''/);
		expect(value).not.toMatch(/[\r\n]/);
		expect(value).toContain('%E6%97%A5%E6%9C%AC%E8%AA%9E');
		expect(objectContentDisposition('folder/', true)).toContain('inline; filename="download"');
		expect(objectContentDisposition("reports/a!b'c(d)*.txt", false)).toContain(
			"filename*=UTF-8''a%21b%27c%28d%29%2A.txt",
		);
		expect(() => objectContentDisposition(`reports/${'a'.repeat(254)}😀`, false)).not.toThrow();
	});

	it('accepts one byte range and rejects malformed or multiple ranges', () => {
		expect(validRangeHeader(undefined)).toBeUndefined();
		expect(validRangeHeader('bytes=0-')).toBe('bytes=0-');
		expect(validRangeHeader('bytes=-10')).toBe('bytes=-10');
		for (const value of ['bytes=0-1,2-3', 'items=0-1', 'bytes=-']) {
			expect(() => validRangeHeader(value)).toThrow(/one valid byte range/);
		}
	});

	it('allows only verified raster response types inline', () => {
		expect(safeObjectContentType('image/png', true)).toBe('image/png');
		expect(safeObjectContentType('image/svg+xml', true)).toBe('application/octet-stream');
		expect(safeObjectContentType('text/html', false)).toBe('application/octet-stream');
	});

	it('releases stream permits on completion and cancellation', async () => {
		const deps = wifDeps(async () => ({ accessKeyId: 'unused', secretAccessKey: 'unused' }));
		const firstRelease = acquireDownload(deps, user.id);
		expect(() => acquireDownload(deps, user.id)).toThrow(ResourceExhaustedError);
		const close = vi.fn();
		const first = body(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array([1]));
					controller.close();
				},
			}),
			close,
		);
		await new Response(streamObjectBody(first, firstRelease, () => {})).arrayBuffer();
		const secondRelease = acquireDownload(deps, user.id);
		const second = body(new ReadableStream({ pull() {} }), close);
		await streamObjectBody(second, secondRelease, () => {}).cancel('gone');
		expect(close).toHaveBeenCalledTimes(1);
		const thirdRelease = acquireDownload(deps, user.id);
		thirdRelease();
	});

	it('enforces both per-user and process download limits with idempotent release', () => {
		const deps = wifDeps(async () => ({ accessKeyId: 'unused', secretAccessKey: 'unused' }));
		const metrics = { increment: vi.fn(), gauge: vi.fn() };
		deps.metrics = metrics;
		deps.dataBrowser!.objectBrowser!.maxConcurrentDownloads = 3;
		deps.dataBrowser!.objectBrowser!.maxConcurrentDownloadsPerUser = 2;
		const first = acquireDownload(deps, 'user-a');
		const second = acquireDownload(deps, 'user-a');
		expect(() => acquireDownload(deps, 'user-a')).toThrow(ResourceExhaustedError);
		const otherUser = acquireDownload(deps, 'user-b');
		expect(() => acquireDownload(deps, 'user-c')).toThrow(ResourceExhaustedError);

		first();
		first();
		const third = acquireDownload(deps, 'user-c');
		second();
		otherUser();
		third();
		expect(metrics.increment).toHaveBeenCalledTimes(2);
		expect(metrics.increment).toHaveBeenCalledWith('object_browser.download.rejected', 1, {
			operation: 'download',
		});
		expect(metrics.gauge).toHaveBeenCalledWith('object_browser.download.active', 3);
		expect(metrics.gauge).toHaveBeenLastCalledWith('object_browser.download.active', 0);
	});

	it('reports a global active-download gauge across operation types', () => {
		const deps = wifDeps(async () => ({ accessKeyId: 'unused', secretAccessKey: 'unused' }));
		const metrics = { increment: vi.fn(), gauge: vi.fn() };
		deps.metrics = metrics;
		deps.dataBrowser!.objectBrowser!.maxConcurrentDownloads = 3;
		deps.dataBrowser!.objectBrowser!.maxConcurrentDownloadsPerUser = 2;

		const releaseDownload = acquireDownload(deps, 'user-a', 'download');
		const releaseInline = acquireDownload(deps, 'user-b', 'inline');
		releaseDownload();
		releaseInline();

		expect(metrics.gauge.mock.calls).toEqual([
			['object_browser.download.active', 1],
			['object_browser.download.active', 2],
			['object_browser.download.active', 1],
			['object_browser.download.active', 0],
		]);
	});

	it('uses the current metrics emitter when limits are shared', () => {
		const firstDeps = wifDeps(async () => ({ accessKeyId: 'unused', secretAccessKey: 'unused' }));
		const firstMetrics = { increment: vi.fn(), gauge: vi.fn() };
		const secondMetrics = { increment: vi.fn(), gauge: vi.fn() };
		firstDeps.metrics = firstMetrics;
		const secondDeps = { ...firstDeps, metrics: secondMetrics };

		const releaseFirst = acquireDownload(firstDeps, 'user-a');
		releaseFirst();
		const releaseSecond = acquireDownload(secondDeps, 'user-b');
		releaseSecond();

		expect(firstMetrics.gauge.mock.calls).toEqual([
			['object_browser.download.active', 1],
			['object_browser.download.active', 0],
		]);
		expect(secondMetrics.gauge.mock.calls).toEqual([
			['object_browser.download.active', 1],
			['object_browser.download.active', 0],
		]);
	});

	it('reports downstream stream cancellation once', async () => {
		const cancel = vi.fn();
		const stream = streamObjectBody(
			body(new ReadableStream({ pull() {} }), vi.fn()),
			vi.fn(),
			vi.fn(),
			undefined,
			cancel,
		);
		await stream.cancel('gone');
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('closes the object and releases its permit after a stream error', async () => {
		const close = vi.fn();
		const release = vi.fn();
		const finish = vi.fn();
		const object = body(
			new ReadableStream({
				pull() {
					throw new Error('upstream failed');
				},
			}),
			close,
		);
		await expect(
			new Response(streamObjectBody(object, release, finish)).arrayBuffer(),
		).rejects.toThrow('upstream failed');
		expect(close).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledOnce();
	});

	it('cleans up even when upstream cancellation rejects', async () => {
		const close = vi.fn();
		const release = vi.fn();
		const finish = vi.fn();
		const object = body(
			new ReadableStream({
				cancel() {
					throw new Error('cancel failed');
				},
			}),
			close,
		);
		await expect(streamObjectBody(object, release, finish).cancel('gone')).rejects.toThrow(
			'cancel failed',
		);
		expect(close).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledOnce();
	});

	it('aborts an open response stream and releases its permit at the operation deadline', async () => {
		const controller = new AbortController();
		const close = vi.fn();
		const release = vi.fn();
		const finish = vi.fn();
		const upstreamCancel = vi.fn();
		const object = body(new ReadableStream({ cancel: upstreamCancel }), close);
		const reader = streamObjectBody(object, release, finish, controller.signal).getReader();
		const pending = reader.read();

		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(upstreamCancel).toHaveBeenCalledOnce());
		expect(close).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledOnce();
	});

	it('releases an unread response stream when its deadline expires', async () => {
		const controller = new AbortController();
		const close = vi.fn();
		const release = vi.fn();
		const finish = vi.fn();
		const stream = streamObjectBody(
			body(new ReadableStream({ pull() {} }), close),
			release,
			finish,
			controller.signal,
		);

		controller.abort();

		await expect(stream.getReader().read()).rejects.toMatchObject({ name: 'AbortError' });
		expect(close).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledOnce();
	});

	it('rejects downloads when object browsing is not configured', () => {
		expect(() => acquireDownload({} as ApiDeps, user.id)).toThrow(/not enabled/);
	});
});

function body(stream: ReadableStream<Uint8Array>, close: () => void): ObjectBody {
	return {
		body: stream,
		status: 200,
		content_type: 'application/octet-stream',
		content_length: 1,
		total_size: 1,
		close,
	};
}
