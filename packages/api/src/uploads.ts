import { z } from '@hono/zod-openapi';
import { UploadStatusSchema } from '@marimo-hub/core/uploads';

export const UploadResponseSchema = z.object({
	success: z.literal(true),
	data: UploadStatusSchema,
});
export const UploadPartBody = {
	content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } },
	required: true,
};
