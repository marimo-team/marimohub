import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
