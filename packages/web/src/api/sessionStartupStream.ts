import { createParser } from 'eventsource-parser';
import { z } from 'zod';
import {
	SANDBOX_STARTUP_PHASES,
	SESSION_STATUSES,
	STARTUP_DETAIL_MAX_LENGTH,
} from '@marimo-hub/core/constants';
import type { SandboxStartupSnapshot } from '@marimo-hub/core/ports/sandbox';
import type { components } from '@marimo-hub/client';
import { apiData } from './client';

type SessionResult = { success: true; data: components['schemas']['SessionCreateResult'] };
const ResultEnvelope = z.object({
	success: z.literal(true),
	data: z.object({ session_id: z.string().min(1), status: z.enum(SESSION_STATUSES) }),
});

function readResult(value: unknown): SessionResult {
	if (!ResultEnvelope.safeParse(value).success) throw new SyntaxError('Invalid session result');
	return value as SessionResult;
}

const Progress = z.object({
	phase: z.enum(SANDBOX_STARTUP_PHASES),
	detail: z.string().max(STARTUP_DETAIL_MAX_LENGTH).optional(),
	started_at: z.iso.datetime(),
	attempt: z.number().int().positive(),
	observed: z.array(z.enum(SANDBOX_STARTUP_PHASES)).max(SANDBOX_STARTUP_PHASES.length),
});
const StreamError = z.object({
	success: z.literal(false),
	error: z.object({
		code: z.string(),
		message: z.string(),
		status: z.number().int().min(400).max(599),
	}),
});

export function readSessionStart(
	request: Promise<{ response: Response; error?: unknown }>,
	onProgress?: (progress: SandboxStartupSnapshot) => void,
) {
	return apiData(
		(async () => {
			const { response, error } = await request;
			if (!response.ok) return { error, response };
			if (!response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
				return { data: readResult(await response.json()), response };
			}
			if (!response.body) throw new Error('Startup response has no stream');
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let terminal: { event: string; data: unknown } | undefined;
			const parser = createParser({
				maxBufferSize: 1024 * 1024,
				onError(error) {
					if (error.type === 'max-buffer-size-exceeded') throw error;
				},
				onEvent({ event, data }) {
					if (terminal) return;
					if (event === 'progress') {
						try {
							const progress = Progress.safeParse(JSON.parse(data));
							if (progress.success) {
								onProgress?.(progress.data);
							}
						} catch {
							/* UI observation must not discard the session result. */
						}
					} else if (event === 'result' || event === 'error')
						terminal = { event, data: JSON.parse(data) };
				},
			});
			try {
				for (;;) {
					if (terminal) break;
					const { done, value } = await reader.read();
					if (done)
						throw new Error(
							'The connection closed before startup completed. Reload to check the session.',
						);
					parser.feed(decoder.decode(value, { stream: true }));
				}
				if (terminal.event === 'error') {
					const error = StreamError.parse(terminal.data);
					return {
						error,
						response: new Response(null, { status: error.error.status, headers: response.headers }),
					};
				}
				return { data: readResult(terminal.data), response };
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		})(),
	);
}
