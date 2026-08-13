import { describe, expect, it, vi } from 'vitest';
import { createProjectId, UserId } from '@marimo-hub/core';
import type { Metrics, ObjectBrowseContext, ObjectStoreSource } from '@marimo-hub/core';
import type { S3ClientLike } from './client';
import { S3ObjectBrowser } from './index';

const source: ObjectStoreSource = {
	provider: 's3',
	configured_bucket: 'private-bucket',
	region: 'us-east-1',
	endpoint: 'https://s3.example.com',
	path_style: true,
	auth: { method: 'static', access_key_id: 'access', secret_access_key: 'secret' },
};

const context: ObjectBrowseContext = {
	project_id: createProjectId(),
	user_id: UserId.parse('user-metrics'),
	user_email: 'metrics@example.com',
	allow_server_ambient: false,
};

describe('S3 object browser metrics', () => {
	it('records operations, latency, failures, scanned keys, and bytes without sensitive tags', async () => {
		const metrics = mockMetrics();
		const browser = harness(
			[
				{ Contents: [{ Key: 'secret/report.csv', Size: 3 }], IsTruncated: false },
				{ ContentLength: 3, ContentType: 'text/csv', ETag: 'etag' },
				{ Body: body('a,b'), ContentLength: 3 },
				Object.assign(new Error('provider detail'), { name: 'InternalError' }),
			],
			metrics,
		);

		await browser.searchObjects(source, context, {
			bucket: 'private-bucket',
			query: 'report',
			limit: 10,
		});
		await browser.previewObject(source, context, {
			bucket: 'private-bucket',
			key: 'secret/report.csv',
			limit: 10,
			content_url: '/content',
		});
		await expect(
			browser.listObjects(source, context, { bucket: 'private-bucket', limit: 10 }),
		).rejects.toMatchObject({ code: 'unavailable' });

		expect(metrics.increment).toHaveBeenCalledWith('object_browser.s3.keys_scanned', 1, {
			operation: 'search_objects',
			mode: 'full',
		});
		expect(metrics.increment).toHaveBeenCalledWith('object_browser.s3.bytes_read', 3, {
			operation: 'preview_object',
			mode: 'full',
		});
		expect(metrics.increment).toHaveBeenCalledWith('object_browser.s3.failures', 1, {
			operation: 'list_objects',
			mode: 'full',
			code: 'unavailable',
		});
		expect(metrics.histogram).toHaveBeenCalledWith(
			'object_browser.s3.latency_ms',
			expect.any(Number),
			expect.any(Object),
		);
		for (const call of [...metrics.increment.mock.calls, ...metrics.histogram.mock.calls]) {
			const tags = call[2];
			expect(Object.keys(tags ?? {}).sort()).toEqual(expect.arrayContaining(['mode', 'operation']));
			expect(JSON.stringify(tags)).not.toMatch(/private-bucket|secret|report|metrics@example/);
		}
	});

	it('distinguishes metadata deadlines from caller cancellations', async () => {
		vi.useFakeTimers();
		try {
			const metrics = mockMetrics();
			const browser = new S3ObjectBrowser({
				mode: 'full',
				limits: { metadataTimeoutMs: 10 },
				metrics,
				clientFactory: () => stalledClient(),
			});
			const timedOut = browser.listObjects(source, context, {
				bucket: 'private-bucket',
				limit: 1,
			});
			const timedOutExpectation = expect(timedOut).rejects.toMatchObject({ code: 'aborted' });
			await vi.advanceTimersByTimeAsync(10);
			await timedOutExpectation;
			expect(metrics.increment).toHaveBeenCalledWith('object_browser.s3.timeouts', 1, {
				operation: 'list_objects',
				mode: 'full',
			});

			const caller = new AbortController();
			const canceled = browser.listObjects(
				source,
				{ ...context, signal: caller.signal },
				{
					bucket: 'private-bucket',
					limit: 1,
				},
			);
			const canceledExpectation = expect(canceled).rejects.toMatchObject({ code: 'aborted' });
			caller.abort();
			await canceledExpectation;
			expect(metrics.increment).toHaveBeenCalledWith('object_browser.s3.cancellations', 1, {
				operation: 'list_objects',
				mode: 'full',
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('counts downloaded bytes when a stream completes or is canceled', async () => {
		const metrics = mockMetrics();
		const browser = harness(
			[
				{ Body: body('hello'), ContentLength: 5 },
				{ Body: body('partial'), ContentLength: 7 },
			],
			metrics,
		);
		const complete = await browser.openObject(source, context, {
			bucket: 'private-bucket',
			key: 'secret.bin',
		});
		expect(await new Response(complete.body).text()).toBe('hello');
		const partial = await browser.openObject(source, context, {
			bucket: 'private-bucket',
			key: 'secret.bin',
		});
		const reader = partial.body.getReader();
		await reader.read();
		await reader.cancel();
		expect(metrics.increment).toHaveBeenCalledWith('object_browser.s3.bytes_read', 5, {
			operation: 'open_object',
			mode: 'full',
		});
		expect(metrics.increment).toHaveBeenCalledWith('object_browser.s3.bytes_read', 7, {
			operation: 'open_object',
			mode: 'full',
		});
		expect(metrics.increment).toHaveBeenCalledWith('object_browser.s3.cancellations', 1, {
			operation: 'open_object',
			mode: 'full',
		});
	});

	it('records a timed-out download separately from caller cancellation', async () => {
		const metrics = mockMetrics();
		const browser = harness([{ Body: body('partial'), ContentLength: 7 }], metrics);
		const opened = await browser.openObject(source, context, {
			bucket: 'private-bucket',
			key: 'secret.bin',
		});
		const reader = opened.body.getReader();
		await reader.read();
		await reader.cancel(new DOMException('deadline exceeded', 'TimeoutError'));

		expect(metrics.increment).toHaveBeenCalledWith('object_browser.s3.timeouts', 1, {
			operation: 'open_object',
			mode: 'full',
		});
		expect(metrics.increment).not.toHaveBeenCalledWith('object_browser.s3.cancellations', 1, {
			operation: 'open_object',
			mode: 'full',
		});
	});

	it('records failures that happen after download headers arrive', async () => {
		const metrics = mockMetrics();
		const failing = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(Object.assign(new Error('provider detail'), { name: 'InternalError' }));
			},
		});
		const browser = harness([{ Body: failing, ContentLength: 1 }], metrics);
		const opened = await browser.openObject(source, context, {
			bucket: 'private-bucket',
			key: 'secret.bin',
		});
		await expect(new Response(opened.body).arrayBuffer()).rejects.toMatchObject({
			code: 'unavailable',
		});
		expect(metrics.increment).toHaveBeenCalledWith('object_browser.s3.failures', 1, {
			operation: 'open_object',
			mode: 'full',
			code: 'unavailable',
		});
	});

	it('includes the raster safety probe in inline download bytes', async () => {
		const metrics = mockMetrics();
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const browser = harness(
			[
				{ ContentLength: png.byteLength, ETag: 'etag' },
				{ Body: new Blob([png]).stream(), ContentLength: png.byteLength },
				{ Body: new Blob([png]).stream(), ContentLength: png.byteLength },
			],
			metrics,
		);
		const opened = await browser.openObject(source, context, {
			bucket: 'private-bucket',
			key: 'secret.png',
			inline: true,
		});
		await new Response(opened.body).arrayBuffer();
		expect(metrics.increment).toHaveBeenCalledWith(
			'object_browser.s3.bytes_read',
			png.byteLength * 2,
			{ operation: 'open_object', mode: 'full' },
		);
	});
});

function harness(responses: unknown[], metrics: Metrics): S3ObjectBrowser {
	const queue = [...responses];
	const client: S3ClientLike = {
		async send() {
			const response = queue.shift();
			if (response instanceof Error) throw response;
			return response;
		},
		destroy() {},
	};
	return new S3ObjectBrowser({ mode: 'full', metrics, clientFactory: () => client });
}

function stalledClient(): S3ClientLike {
	return {
		send(_command, options) {
			return new Promise((_resolve, reject) => {
				options?.abortSignal?.addEventListener(
					'abort',
					() => reject(new DOMException('aborted', 'AbortError')),
					{ once: true },
				);
			});
		},
		destroy() {},
	};
}

function mockMetrics() {
	return {
		increment: vi.fn<Metrics['increment']>(),
		gauge: vi.fn<Metrics['gauge']>(),
		histogram: vi.fn<NonNullable<Metrics['histogram']>>(),
	};
}

function body(value: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(value));
			controller.close();
		},
	});
}
