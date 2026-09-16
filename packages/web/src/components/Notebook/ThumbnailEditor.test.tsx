import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonError, jsonOk, renderWithClient } from '@/test/render';
import ThumbnailEditor from './ThumbnailEditor';

const png = new Blob(['cropped PNG'], { type: 'image/png' });
const original = () => new File(['original screenshot'], 'screen.jpg', { type: 'image/jpeg' });
let requests: { method: string; body: unknown }[];
let rejectUpload = false;
let drawImage: ReturnType<typeof vi.fn>;
beforeEach(() => {
	requests = [];
	rejectUpload = false;
	drawImage = vi.fn();
	vi.stubGlobal(
		'createImageBitmap',
		vi.fn().mockResolvedValue({ width: 1200, height: 900, close: vi.fn() }),
	);
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
		drawImage,
		fillRect: vi.fn(),
	} as never);
	vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AA==');
	vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
		function (this: HTMLCanvasElement, callback) {
			expect(this.width).toBe(960);
			expect(this.height).toBe(540);
			callback(png);
		},
	);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_input, init) => {
			const method = init?.method ?? 'GET';
			requests.push({ method, body: init?.body });
			if (method === 'PUT' && rejectUpload) return jsonError('INTERNAL_ERROR', 'Upload failed');
			return jsonOk({ source: 'custom', has_custom: true, revision: '1', captured_at: null });
		}),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function loadCrop() {
	const image = await screen.findByAltText('Screenshot to crop');
	Object.defineProperties(image, {
		width: { value: 600 },
		height: { value: 450 },
		naturalWidth: { value: 1200 },
		naturalHeight: { value: 900 },
	});
	fireEvent.load(image);
	await waitFor(() => expect(screen.getByRole('button', { name: 'Save thumbnail' })).toBeEnabled());
}
function renderEditor() {
	const onClose = vi.fn();
	const result = renderWithClient(
		<ThumbnailEditor projectId="p" notebookId="n" onClose={onClose} />,
	);
	return { ...result, onClose };
}

function pendingBitmap() {
	let resolve!: (value: ImageBitmap) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<ImageBitmap>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	const bitmap = { width: 1200, height: 900, close: vi.fn() } as unknown as ImageBitmap;
	return { promise, bitmap, resolve: () => resolve(bitmap), reject };
}
function pasteImage() {
	fireEvent.paste(screen.getByRole('button', { name: 'Close' }), {
		clipboardData: { files: [original()] },
	});
}

describe('thumbnail editor', () => {
	it('decodes an upload locally and uploads only the 960×540 crop', async () => {
		const user = userEvent.setup();
		const { onClose } = renderEditor();
		const file = original();
		await user.upload(document.querySelector('input[type=file]')!, file);
		await loadCrop();
		expect(createImageBitmap).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
		await user.click(screen.getByRole('button', { name: 'Save thumbnail' }));
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(requests.filter((r) => r.method === 'PUT')).toEqual([{ method: 'PUT', body: png }]);
		expect(drawImage).toHaveBeenLastCalledWith(
			expect.any(HTMLImageElement),
			0,
			112.5,
			1200,
			675,
			0,
			0,
			960,
			540,
		);
	});
	it('accepts native paste from a dialog control, and cancellation never uploads', async () => {
		const user = userEvent.setup();
		const { onClose } = renderEditor();
		fireEvent.paste(screen.getByRole('button', { name: 'Close' }), {
			clipboardData: { files: [original()] },
		});
		await loadCrop();
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(requests.some((r) => r.method !== 'GET')).toBe(false);
	});
	it('accepts a dropped file', async () => {
		renderEditor();
		const file = original();
		const dataTransfer = {
			types: ['Files'],
			files: [file],
			getData: () => '',
			items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
		};
		const dropzone = screen.getByLabelText('Upload or paste a thumbnail');
		fireEvent.dragEnter(dropzone, { dataTransfer });
		fireEvent.dragOver(dropzone, { dataTransfer });
		fireEvent.drop(dropzone, { dataTransfer });
		await loadCrop();
	});
	it('keeps the dialog and current thumbnail when an upload fails', async () => {
		rejectUpload = true;
		const user = userEvent.setup();
		const { onClose } = renderEditor();
		fireEvent.paste(screen.getByRole('button', { name: 'Cancel' }), {
			clipboardData: { files: [original()] },
		});
		await loadCrop();
		await user.click(screen.getByRole('button', { name: 'Save thumbnail' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed');
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Remove custom thumbnail' })).toBeEnabled();
	});
	it('rejects unsupported and oversized pasted images before decoding', async () => {
		renderEditor();
		const oversized = new File(['image'], 'large.png', { type: 'image/png' });
		Object.defineProperty(oversized, 'size', { value: 10 * 1024 * 1024 + 1 });
		for (const file of [new File(['svg'], 'image.svg', { type: 'image/svg+xml' }), oversized]) {
			fireEvent.paste(screen.getByRole('button', { name: 'Cancel' }), {
				clipboardData: { files: [file] },
			});
			expect(await screen.findByRole('alert')).toHaveTextContent('Choose a PNG, JPEG, or WebP');
		}
		expect(createImageBitmap).not.toHaveBeenCalled();
		expect(requests.some((r) => r.method !== 'GET')).toBe(false);
	});

	it('disables Save while decoding a replacement and resets the crop for the same image', async () => {
		const user = userEvent.setup();
		renderEditor();
		pasteImage();
		await loadCrop();
		const previous = screen.getByAltText('Screenshot to crop');
		const next = pendingBitmap();
		vi.mocked(createImageBitmap).mockReturnValueOnce(next.promise);
		pasteImage();
		expect(screen.getByRole('button', { name: 'Save thumbnail' })).toBeDisabled();
		await user.click(screen.getByRole('button', { name: 'Save thumbnail' }));
		expect(requests.some((r) => r.method === 'PUT')).toBe(false);
		await act(async () => {
			next.resolve();
		});
		expect(screen.getByAltText('Screenshot to crop')).not.toBe(previous);
		await loadCrop();
		expect(next.bitmap.close).toHaveBeenCalledOnce();
	});
	it.each(['resolve', 'reject'] as const)(
		'ignores an older decode that finishes with %s after a newer selection',
		async (outcome) => {
			renderEditor();
			const first = pendingBitmap();
			const second = pendingBitmap();
			vi.mocked(createImageBitmap)
				.mockReturnValueOnce(first.promise)
				.mockReturnValueOnce(second.promise);
			pasteImage();
			pasteImage();
			await act(async () => {
				second.resolve();
			});
			await loadCrop();
			const selected = screen.getByAltText('Screenshot to crop');
			await act(async () => {
				if (outcome === 'resolve') first.resolve();
				else first.reject(new Error('Old image failed'));
			});
			expect(screen.getByAltText('Screenshot to crop')).toBe(selected);
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Save thumbnail' })).toBeEnabled();
			if (outcome === 'resolve') expect(first.bitmap.close).toHaveBeenCalledOnce();
		},
	);
	it('discards a decode completed after cancellation and releases its bitmap', async () => {
		const user = userEvent.setup();
		const { onClose } = renderEditor();
		const pending = pendingBitmap();
		vi.mocked(createImageBitmap).mockReturnValueOnce(pending.promise);
		pasteImage();
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		await act(async () => {
			pending.resolve();
		});
		expect(onClose).toHaveBeenCalledOnce();
		expect(pending.bitmap.close).toHaveBeenCalledOnce();
		expect(screen.queryByAltText('Screenshot to crop')).not.toBeInTheDocument();
		expect(requests.some((r) => r.method !== 'GET')).toBe(false);
	});

	it('keeps the custom override available when removal fails', async () => {
		const user = userEvent.setup();
		const { onClose } = renderEditor();
		const remove = await screen.findByRole('button', { name: 'Remove custom thumbnail' });
		vi.mocked(fetch).mockResolvedValueOnce(
			jsonError('INTERNAL_ERROR', 'Could not remove thumbnail'),
		);
		await user.click(remove);
		expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove thumbnail');
		expect(remove).toBeEnabled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('removes the custom override', async () => {
		const user = userEvent.setup();
		const { onClose } = renderEditor();
		await user.click(await screen.findByRole('button', { name: 'Remove custom thumbnail' }));
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
		expect(requests.some((r) => r.method === 'DELETE')).toBe(true);
	});
});
