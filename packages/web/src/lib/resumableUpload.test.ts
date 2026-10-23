import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_BYTES, UPLOAD_PART_BYTES } from '@marimo-hub/core/uploads';
import { resumableUpload } from './resumableUpload';

const { Blob } = await vi.importActual<{ Blob: typeof globalThis.Blob }>('node:buffer');
const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');

const id = 'a2a33248-6315-4f53-aa27-ef0cfc9e9f18';
const status = (parts_done: number[] = []) =>
	Response.json({
		data: {
			id,
			size: 6,
			part_size: 3,
			parts_done,
			status: 'uploading',
		},
	});
const file = () => new Blob(['abcdef']) as unknown as globalThis.Blob;

beforeEach(() => {
	sessionStorage.clear();
	vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => vi.unstubAllGlobals());

describe('resumableUpload', () => {
	it('resumes only missing parts after a lost connection and clears its receipt', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(status())
			.mockResolvedValueOnce(status([1]))
			.mockRejectedValueOnce(new TypeError('connection lost'));
		vi.stubGlobal('fetch', fetcher);
		const progress = vi.fn();
		await expect(
			resumableUpload('/uploads', file(), { path: 'data.bin' }, { onProgress: progress }),
		).rejects.toThrow('connection lost');
		expect(sessionStorage.length).toBe(1);
		expect(progress).toHaveBeenLastCalledWith(null);
		fetcher
			.mockReset()
			.mockResolvedValueOnce(status([1]))
			.mockResolvedValueOnce(status([1, 2]))
			.mockResolvedValueOnce(Response.json({ success: true }));
		await resumableUpload('/uploads', file(), { path: 'data.bin' });
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			`/uploads/${id}`,
			`/uploads/${id}/parts/2`,
			`/uploads/${id}/complete`,
		]);
		expect(sessionStorage.length).toBe(0);
	});

	it('does not reuse parts for different contents with the same path and size', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(status())
			.mockRejectedValueOnce(new Error('offline'));
		vi.stubGlobal('fetch', fetcher);
		await expect(resumableUpload('/uploads', file(), { path: 'data.bin' })).rejects.toThrow();
		fetcher
			.mockReset()
			.mockResolvedValueOnce(status())
			.mockResolvedValueOnce(status([1]))
			.mockResolvedValueOnce(status([1, 2]))
			.mockResolvedValueOnce(Response.json({ success: true }));
		await resumableUpload('/uploads', new Blob(['ghijkl']) as unknown as globalThis.Blob, {
			path: 'data.bin',
		});
		expect(fetcher.mock.calls[0]).toMatchObject(['/uploads', { method: 'POST' }]);
	});

	it('keeps a completed set of parts when an editor blocks publication', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(status())
			.mockResolvedValueOnce(status([1]))
			.mockResolvedValueOnce(status([1, 2]))
			.mockResolvedValueOnce(
				Response.json(
					{ success: false, error: { code: 'CONFLICT', message: 'Editor active' } },
					{ status: 409 },
				),
			);
		vi.stubGlobal('fetch', fetcher);
		await expect(resumableUpload('/uploads', file(), { path: 'data.bin' })).rejects.toThrow(
			'Editor active',
		);
		fetcher
			.mockReset()
			.mockResolvedValueOnce(status([1, 2]))
			.mockResolvedValueOnce(Response.json({ success: true }));
		await resumableUpload('/uploads', file(), { path: 'data.bin' });
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			`/uploads/${id}`,
			`/uploads/${id}/complete`,
		]);
	});
});

describe('resumableUpload failures', () => {
	async function leaveReceipt() {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(status())
			.mockRejectedValueOnce(new Error('offline'));
		vi.stubGlobal('fetch', fetcher);
		await expect(resumableUpload('/uploads', file(), { path: 'data.bin' })).rejects.toThrow(
			'offline',
		);
		return fetcher.mockReset();
	}

	it('starts a fresh upload when its saved receipt has expired', async () => {
		const fetcher = await leaveReceipt();
		fetcher
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce(status())
			.mockResolvedValueOnce(status([1]))
			.mockResolvedValueOnce(status([1, 2]))
			.mockResolvedValueOnce(Response.json({ success: true }));
		await resumableUpload('/uploads', file(), { path: 'data.bin' });
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			`/uploads/${id}`,
			'/uploads',
			`/uploads/${id}/parts/1`,
			`/uploads/${id}/parts/2`,
			`/uploads/${id}/complete`,
		]);
		expect(sessionStorage.length).toBe(0);
	});

	it.each([403, 409, 503])(
		'does not silently start over when resuming returns %i',
		async (code) => {
			const fetcher = await leaveReceipt();
			fetcher.mockResolvedValueOnce(
				Response.json(
					{ success: false, error: { code: 'FAILED', message: 'Resume denied' } },
					{ status: code },
				),
			);
			await expect(resumableUpload('/uploads', file(), { path: 'data.bin' })).rejects.toThrow(
				'Resume denied',
			);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(sessionStorage.length).toBe(1);
		},
	);

	it('recovers a lost completion response without resending parts', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(status())
			.mockResolvedValueOnce(status([1]))
			.mockResolvedValueOnce(status([1, 2]))
			.mockRejectedValueOnce(new Error('response lost'));
		vi.stubGlobal('fetch', fetcher);
		await expect(resumableUpload('/uploads', file(), { path: 'data.bin' })).rejects.toThrow(
			'response lost',
		);
		fetcher
			.mockReset()
			.mockResolvedValueOnce(
				Response.json({
					data: { id, size: 6, part_size: 3, parts_done: [1, 2], status: 'complete' },
				}),
			)
			.mockResolvedValueOnce(Response.json({ success: true }));
		await resumableUpload('/uploads', file(), { path: 'data.bin' });
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			`/uploads/${id}`,
			`/uploads/${id}/complete`,
		]);
		expect(sessionStorage.length).toBe(0);
	});

	it('retains its receipt when the completion body fails after successful headers', async () => {
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"success":'));
				controller.error(new TypeError('Response body lost'));
			},
		});
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(status())
			.mockResolvedValueOnce(status([1]))
			.mockResolvedValueOnce(status([1, 2]))
			.mockResolvedValueOnce(new Response(body));
		vi.stubGlobal('fetch', fetcher);
		await expect(resumableUpload('/uploads', file(), { path: 'data.bin' })).rejects.toThrow(
			'Response body lost',
		);
		expect(sessionStorage.length).toBe(1);
		fetcher
			.mockReset()
			.mockResolvedValueOnce(status([1, 2]))
			.mockResolvedValueOnce(Response.json({ success: true }));
		const response = await resumableUpload('/uploads', file(), { path: 'data.bin' });
		expect(await response.json()).toEqual({ success: true });
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			`/uploads/${id}`,
			`/uploads/${id}/complete`,
		]);
		expect(sessionStorage.length).toBe(0);
	});

	it.each([200, 404, 409])(
		'explicit restart cancels the old upload before discarding its receipt (%i)',
		async (code) => {
			const fetcher = await leaveReceipt();
			fetcher
				.mockResolvedValueOnce(new Response(null, { status: code }))
				.mockResolvedValueOnce(status())
				.mockResolvedValueOnce(status([1]))
				.mockResolvedValueOnce(status([1, 2]))
				.mockResolvedValueOnce(Response.json({ success: true }));
			await resumableUpload('/uploads', file(), { path: 'data.bin' }, { restart: true });
			expect(fetcher.mock.calls[0]).toMatchObject([`/uploads/${id}`, { method: 'DELETE' }]);
			expect(fetcher.mock.calls[1]).toMatchObject(['/uploads', { method: 'POST' }]);
			expect(sessionStorage.length).toBe(0);
		},
	);

	it.each([403, 503])(
		'retains the old receipt if explicit cancellation fails (%i)',
		async (code) => {
			const fetcher = await leaveReceipt();
			fetcher.mockResolvedValueOnce(
				Response.json(
					{ success: false, error: { code: 'FAILED', message: 'Cancellation failed' } },
					{ status: code },
				),
			);
			await expect(
				resumableUpload('/uploads', file(), { path: 'data.bin' }, { restart: true }),
			).rejects.toThrow('Cancellation failed');
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(sessionStorage.length).toBe(1);
		},
	);

	it('retains a receipt after aborting between parts and clears progress', async () => {
		const controller = new AbortController();
		const progress = vi.fn((value) => {
			if (value?.phase === 'uploading') controller.abort();
		});
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(status())
			.mockResolvedValueOnce(status([1]));
		vi.stubGlobal('fetch', fetcher);
		await expect(
			resumableUpload(
				'/uploads',
				file(),
				{ path: 'data.bin' },
				{ signal: controller.signal, onProgress: progress },
			),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(sessionStorage.length).toBe(1);
		expect(progress).toHaveBeenLastCalledWith(null);
	});

	it.each([
		{ part_size: UPLOAD_PART_BYTES + 1 },
		{ part_size: 0 },
		{ size: MAX_UPLOAD_BYTES + 1 },
		{ size: 7 },
	])('rejects unsafe server limits: %j', async (invalid) => {
		const fetcher = vi.fn().mockResolvedValueOnce(
			Response.json({
				data: { id, size: 6, part_size: 3, parts_done: [], status: 'uploading', ...invalid },
			}),
		);
		vi.stubGlobal('fetch', fetcher);
		await expect(resumableUpload('/uploads', file(), { path: 'data.bin' })).rejects.toMatchObject(
			invalid.size === 7
				? { message: 'Server returned invalid upload limits' }
				: { name: 'ZodError' },
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('publishes an empty file without a part request', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ data: { id, size: 0, part_size: 3, parts_done: [], status: 'uploading' } }),
			)
			.mockResolvedValueOnce(Response.json({ success: true }));
		vi.stubGlobal('fetch', fetcher);
		await resumableUpload('/uploads', new Blob([]) as unknown as globalThis.Blob, {
			path: 'empty',
		});
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/uploads', `/uploads/${id}/complete`]);
	});
});
