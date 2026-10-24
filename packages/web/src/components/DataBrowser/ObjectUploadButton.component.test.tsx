import { MAX_UPLOAD_BYTES } from '@marimo-hub/core/uploads';
import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/api/client';
import { refreshBrowseQueries } from '@/api/hooks';
import { browseKeys } from '@/api/queryKeys';
import { formatBytes } from '@/lib/formatBytes';
import { resumableUpload } from '@/lib/resumableUpload';
import { ObjectUploadButton } from './ObjectUploadButton';

vi.mock('@/lib/resumableUpload', () => ({ resumableUpload: vi.fn() }));
const uploader = vi.mocked(resumableUpload);
const first = new File(['first'], 'first.csv');
const second = new File(['second'], 'second.csv');

function setup(files: File[], onRefresh?: () => void) {
	const onComplete = vi.fn(onRefresh);
	const view = render(
		<ObjectUploadButton
			projectId="project"
			integrationId="integration"
			bucket="bucket"
			prefix="folder/"
			onComplete={onComplete}
		/>,
	);
	fireEvent.change(screen.getByLabelText('Upload objects'), { target: { files } });
	return { ...view, onComplete };
}

function blockUploadsUntilAbort(publishing = false) {
	uploader.mockImplementation(
		(_base, file, input, options) =>
			new Promise((_resolve, reject) => {
				if (publishing) {
					options?.onProgress?.({
						path: input.path,
						phase: 'publishing',
						loaded: file.size,
						total: file.size,
					});
				}
				options?.signal?.addEventListener(
					'abort',
					() => reject(new DOMException('Cancelled', 'AbortError')),
					{
						once: true,
					},
				);
			}),
	);
}

beforeEach(() => {
	uploader.mockReset();
});

describe('ObjectUploadButton', () => {
	it('validates the entire selection before uploading and names oversized files', async () => {
		const large = new File([], 'large.bin');
		Object.defineProperty(large, 'size', { value: MAX_UPLOAD_BYTES + 1 });
		const { onComplete } = setup([first, large]);
		expect(await screen.findByRole('alert')).toHaveTextContent(
			`large.bin exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit.`,
		);
		expect(screen.getByRole('alert')).not.toHaveTextContent('resume');
		expect(uploader).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
	});

	it('uploads the whole batch and refreshes once', async () => {
		uploader.mockResolvedValue(new Response());
		const { onComplete } = setup([first, second]);
		await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
		expect(uploader.mock.calls.map((call) => call[2].path)).toEqual([
			'folder/first.csv',
			'folder/second.csv',
		]);
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('continues after a failed file, names the failure, and refreshes successful files once', async () => {
		uploader
			.mockRejectedValueOnce(new ApiRequestError('FORBIDDEN', 'Write denied', { status: 403 }))
			.mockResolvedValue(new Response());
		const { onComplete } = setup([first, second]);
		expect(await screen.findByRole('alert')).toHaveTextContent('first.csv: Write denied.');
		expect(screen.getByRole('alert')).not.toHaveTextContent('resume');
		expect(uploader).toHaveBeenCalledTimes(2);
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it('offers resume only for interrupted transfers and does not refresh a failed batch', async () => {
		uploader.mockRejectedValue(new TypeError('Connection lost'));
		const { onComplete } = setup([first]);
		expect(await screen.findByRole('alert')).toHaveTextContent(
			'first.csv: Connection lost. Select the same file to resume an interrupted upload.',
		);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it('cancels the active transfer and skips the remaining files', async () => {
		blockUploadsUntilAbort();
		const { onComplete } = setup([first, second]);
		const signal = uploader.mock.calls[0]?.[3]?.signal;
		await userEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Upload cancelled.');
		expect(signal?.aborted).toBe(true);
		expect(uploader).toHaveBeenCalledTimes(1);
		expect(onComplete).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
	});

	it('refreshes after cancellation during publication and skips the remaining files', async () => {
		uploader.mockImplementation(
			(_base, _file, input, options) =>
				new Promise((_resolve, reject) => {
					options?.onProgress?.({ path: input.path, phase: 'publishing', loaded: 5, total: 5 });
					options?.signal?.addEventListener(
						'abort',
						() => {
							options.onProgress?.(null);
							reject(new DOMException('Cancelled', 'AbortError'));
						},
						{ once: true },
					);
				}),
		);
		const { onComplete } = setup([first, second]);
		await userEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
		expect(await screen.findByRole('alert')).toHaveTextContent('Upload cancelled.');
		expect(uploader).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it('refreshes when the publication response is lost', async () => {
		uploader.mockImplementation(async (_base, _file, input, options) => {
			options?.onProgress?.({ path: input.path, phase: 'publishing', loaded: 5, total: 5 });
			options?.onProgress?.(null);
			throw new TypeError('Connection lost');
		});
		const { onComplete } = setup([first]);
		expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost.');
		expect(onComplete).toHaveBeenCalledTimes(1);
	});

	it('restarts a conflicted upload only after explicit confirmation', async () => {
		uploader.mockRejectedValueOnce(
			new ApiRequestError('CONFLICT', 'Integration changed', { status: 409 }),
		);
		setup([first]);
		const restart = await screen.findByRole('button', { name: 'Restart first.csv' });
		const confirm = vi
			.spyOn(window, 'confirm')
			.mockReturnValueOnce(false)
			.mockReturnValueOnce(true);
		await userEvent.click(restart);
		expect(uploader).toHaveBeenCalledTimes(1);
		uploader.mockResolvedValueOnce(new Response());
		await userEvent.click(restart);
		await waitFor(() => expect(uploader).toHaveBeenCalledTimes(2));
		expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Check the destination first'));
		expect(uploader.mock.calls[1]?.[3]).toMatchObject({ restart: true });
		confirm.mockRestore();
	});

	it('aborts on unmount without starting another file or refreshing', async () => {
		blockUploadsUntilAbort();
		const { unmount, onComplete } = setup([first, second]);
		const signal = uploader.mock.calls[0]?.[3]?.signal;
		unmount();
		await waitFor(() => expect(signal?.aborted).toBe(true));
		expect(uploader).toHaveBeenCalledTimes(1);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it.each(['projectId', 'integrationId', 'bucket', 'prefix'] as const)(
		'clears failed uploads when %s changes',
		async (field) => {
			uploader.mockRejectedValueOnce(
				new ApiRequestError('CONFLICT', 'Integration changed', { status: 409 }),
			);
			const { rerender, onComplete } = setup([first]);
			await screen.findByRole('button', { name: 'Restart first.csv' });
			const destination = {
				projectId: 'project',
				integrationId: 'integration',
				bucket: 'bucket',
				prefix: 'folder/',
				[field]: 'other',
			};
			rerender(<ObjectUploadButton {...destination} onComplete={onComplete} />);
			expect(screen.queryByRole('button', { name: 'Restart first.csv' })).not.toBeInTheDocument();
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
			expect(uploader).toHaveBeenCalledTimes(1);
		},
	);

	it('aborts an active batch when navigating to another folder', async () => {
		blockUploadsUntilAbort();
		const { rerender, onComplete } = setup([first, second]);
		const signal = uploader.mock.calls[0]?.[3]?.signal;
		rerender(
			<ObjectUploadButton
				projectId="project"
				integrationId="integration"
				bucket="bucket"
				prefix="other/"
				onComplete={onComplete}
			/>,
		);
		await waitFor(() => expect(signal?.aborted).toBe(true));
		expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
		expect(uploader).toHaveBeenCalledTimes(1);
		expect(onComplete).not.toHaveBeenCalled();
	});

	it.each(['completed file', 'uncertain publication'] as const)(
		'refreshes the previous destination after navigating away with %s',
		async (publication) => {
			blockUploadsUntilAbort(publication === 'uncertain publication');
			if (publication === 'completed file') uploader.mockResolvedValueOnce(new Response());
			const client = new QueryClient();
			const previousListing = browseKeys.objects('project', 'integration', 'bucket', 'folder/');
			client.setQueryData(previousListing, { pages: [{ items: [], next_cursor: null }] });
			const { rerender, onComplete } = setup([first, second], () => {
				void refreshBrowseQueries(client);
			});
			const started = publication === 'completed file' ? 2 : 1;
			await waitFor(() => expect(uploader).toHaveBeenCalledTimes(started));
			const signal = uploader.mock.calls[started - 1]?.[3]?.signal;
			const nextComplete = vi.fn();
			rerender(
				<ObjectUploadButton
					projectId="project"
					integrationId="integration"
					bucket="bucket"
					prefix="other/"
					onComplete={nextComplete}
				/>,
			);
			await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
			expect(client.getQueryState(previousListing)).toBeUndefined();
			expect(signal?.aborted).toBe(true);
			expect(nextComplete).not.toHaveBeenCalled();
			expect(uploader).toHaveBeenCalledTimes(started);
			expect(screen.getByRole('button', { name: 'Upload' })).toBeEnabled();
			expect(screen.queryByRole('alert')).not.toBeInTheDocument();
			client.clear();
		},
	);
});
