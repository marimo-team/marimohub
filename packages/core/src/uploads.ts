import { z } from 'zod';

export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;

export const UploadStatusSchema = z.object({
	id: z.uuid(),
	path: z.string(),
	size: z.number().int().nonnegative().max(MAX_UPLOAD_BYTES),
	part_size: z.number().int().positive().max(UPLOAD_PART_BYTES),
	parts_done: z.array(z.number().int().positive()),
	expires_at: z.number(),
	status: z.enum(['uploading', 'publishing', 'complete', 'cancelled']),
});
