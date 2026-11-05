import { z } from 'zod';

export const HostEventSchema = z.object({
	event: z.string(),
	id: z.string().optional(),
	data: z.record(z.string(), z.unknown()),
});
export type HostEvent = z.infer<typeof HostEventSchema>;

export const HostReplySchema = z.object({
	status: z.number().int().min(100).max(599),
	body: z.unknown().optional(),
	events: z.array(HostEventSchema).optional(),
	notebook: z.looseObject({ id: z.string(), operations: z.array(z.string()) }),
});
export type HostReply = z.infer<typeof HostReplySchema>;

/** A request to the runtime's own host API, addressed by the notebook's path in its workspace. */
export interface HostRequest {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	path: string;
	notebookPath: string;
	body?: unknown;
	headers?: Record<string, string>;
}
