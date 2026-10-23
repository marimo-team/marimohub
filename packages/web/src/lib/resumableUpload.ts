import { z } from 'zod';
import { UPLOAD_PART_BYTES, UploadStatusSchema } from '@marimo-hub/core/uploads';
import { apiErrorFromResponse } from '@/api/client';

export interface UploadProgress {
	path: string;
	phase: 'preparing' | 'uploading' | 'publishing';
	loaded: number;
	total: number;
}
const UploadResponseSchema = z.object({
	data: UploadStatusSchema.omit({ path: true, expires_at: true }),
});
type UploadStatus = z.infer<typeof UploadResponseSchema>['data'];
async function uploadResponse(response: Response): Promise<UploadStatus> {
	if (!response.ok) throw await apiErrorFromResponse(response, 'Upload failed');
	const value = await response.json();
	return UploadResponseSchema.parse(value).data;
}
function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
function readResume(key: string): string | null {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}
function saveResume(key: string, id: string | null) {
	try {
		if (id) sessionStorage.setItem(key, id);
		else sessionStorage.removeItem(key);
	} catch {
		/* Uploads still work when browser storage is unavailable. */
	}
}

export async function resumableUpload(
	base: string,
	file: Blob,
	input: { path: string; create_only?: boolean; bucket?: string; content_type?: string },
	options: {
		signal?: AbortSignal;
		onProgress?: (progress: UploadProgress | null) => void;
		restart?: boolean;
	} = {},
): Promise<Response> {
	const { signal, onProgress } = options;
	const progress = (phase: UploadProgress['phase'], loaded: number) =>
		onProgress?.({ path: input.path, phase, loaded, total: file.size });
	try {
		// A content fingerprint prevents a same-name replacement from mixing with old parts after reload.
		const hashes: string[] = [];
		progress('preparing', 0);
		for (let offset = 0; offset < file.size; offset += UPLOAD_PART_BYTES) {
			signal?.throwIfAborted();
			const end = Math.min(file.size, offset + UPLOAD_PART_BYTES);
			hashes.push(
				hex(await crypto.subtle.digest('SHA-256', await file.slice(offset, end).arrayBuffer())),
			);
			progress('preparing', end);
		}
		const fingerprint = hex(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hashes.join(''))),
		);
		const resumeKey = `marimohub-upload:${base}:${JSON.stringify(input)}:${file.size}:${fingerprint}`;
		let previous = readResume(resumeKey);
		if (previous && options.restart) {
			const response = await fetch(`${base}/${encodeURIComponent(previous)}`, {
				method: 'DELETE',
				signal,
			});
			// Only an explicit restart can discard an uncertain publication's local receipt.
			if (!response.ok && response.status !== 404 && response.status !== 409)
				throw await apiErrorFromResponse(response, 'Previous upload could not be cancelled');
			saveResume(resumeKey, null);
			previous = null;
		}
		let upload: UploadStatus | undefined;
		if (previous) {
			const response = await fetch(`${base}/${encodeURIComponent(previous)}`, { signal });
			if (response.status === 404) saveResume(resumeKey, null);
			else upload = await uploadResponse(response);
		}
		if (!upload) {
			upload = await uploadResponse(
				await fetch(base, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ...input, size: file.size }),
					signal,
				}),
			);
			saveResume(resumeKey, upload.id);
		}
		if (upload.size !== file.size) throw new Error('Server returned invalid upload limits');
		const completed = new Set(upload.parts_done);
		let loaded = 0;
		for (let offset = 0, number = 1; offset < file.size; offset += upload.part_size, number++) {
			signal?.throwIfAborted();
			const end = Math.min(file.size, offset + upload.part_size);
			if (!completed.has(number)) {
				await uploadResponse(
					await fetch(`${base}/${upload.id}/parts/${number}`, {
						method: 'PUT',
						headers: { 'content-type': 'application/octet-stream' },
						body: file.slice(offset, end),
						signal,
					}),
				);
			}
			loaded += end - offset;
			progress('uploading', loaded);
		}
		progress('publishing', file.size);
		const response = await fetch(`${base}/${upload.id}/complete`, { method: 'POST', signal });
		if (!response.ok) throw await apiErrorFromResponse(response, 'Upload could not be completed');
		await response.clone().json();
		saveResume(resumeKey, null);
		return response;
	} finally {
		onProgress?.(null);
	}
}
