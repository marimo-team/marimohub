import type { Session } from '../../schema';
import { kernelBasePath } from './sessionLifecycle';

export interface KernelSession {
	id: string;
	path?: string;
	[key: string]: unknown;
}

export interface KernelOutput {
	mimetype: string;
	data: unknown;
}

export interface KernelExecuteResult {
	completed: boolean;
	success: boolean;
	stdout: string;
	stderr: string;
	output?: KernelOutput;
	truncated: boolean;
	timedOut: boolean;
}

export interface SseEvent {
	event?: string;
	data: string;
}

export class KernelHttpError extends Error {
	constructor(
		readonly status: number,
		readonly detail: string,
	) {
		super(`Kernel request failed (${status}): ${detail}`);
		this.name = 'KernelHttpError';
	}
}

export function kernelBaseUrl(session: Session): string {
	const endpoint = session.sandbox_origin_url ?? session.sandbox_url;
	if (!endpoint) throw new Error('Session has no sandbox URL');
	const origin = new URL(endpoint).origin;
	return `${origin}${kernelBasePath(session)}`;
}

async function responseDetail(response: Response): Promise<string> {
	try {
		const json = (await response.clone().json()) as Record<string, unknown>;
		const detail = json.detail ?? json.message ?? json.error;
		if (typeof detail === 'string') return detail;
	} catch {
		// Fall through to the response text.
	}
	try {
		return (await response.text()).slice(0, 2_000) || response.statusText;
	} catch {
		return response.statusText;
	}
}

async function assertKernelResponse(response: Response, contentType?: string): Promise<void> {
	if (!response.ok) throw new KernelHttpError(response.status, await responseDetail(response));
	if (contentType && !response.headers.get('content-type')?.includes(contentType)) {
		throw new KernelHttpError(response.status, `Expected ${contentType} response`);
	}
}

export async function listKernelSessions(
	baseUrl: string,
	options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<KernelSession[]> {
	const response = await (options.fetchImpl ?? globalThis.fetch)(`${baseUrl}/api/sessions`, {
		headers: { Accept: 'application/json' },
		signal: options.signal,
	});
	await assertKernelResponse(response);
	const json = await response.json();
	const sessions = Array.isArray(json)
		? json
		: typeof json === 'object' &&
			  json !== null &&
			  Array.isArray((json as { sessions?: unknown }).sessions)
			? (json as { sessions: unknown[] }).sessions
			: [];
	return sessions.flatMap((value) => {
		if (typeof value !== 'object' || value === null) return [];
		const candidate = value as { id?: unknown; session_id?: unknown; path?: unknown };
		const id = typeof candidate.id === 'string' ? candidate.id : candidate.session_id;
		if (typeof id !== 'string') return [];
		const normalized: KernelSession = { ...value, id };
		return [normalized];
	});
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let event: string | undefined;
	let data: string[] = [];

	const consumeLine = (line: string): SseEvent | undefined => {
		if (line === '') {
			if (data.length === 0) {
				event = undefined;
				return undefined;
			}
			const parsed = { ...(event ? { event } : {}), data: data.join('\n') };
			event = undefined;
			data = [];
			return parsed;
		}
		if (line.startsWith(':')) return undefined;
		const separator = line.indexOf(':');
		const field = separator === -1 ? line : line.slice(0, separator);
		let value = separator === -1 ? '' : line.slice(separator + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'event') event = value;
		if (field === 'data') data.push(value);
		return undefined;
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			for (;;) {
				const newline = buffer.search(/[\r\n]/);
				if (
					newline === -1 ||
					(!done && buffer[newline] === '\r' && newline === buffer.length - 1)
				) {
					break;
				}
				const line = buffer.slice(0, newline);
				const width = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1;
				buffer = buffer.slice(newline + width);
				const parsed = consumeLine(line);
				if (parsed) yield parsed;
			}
			if (done) {
				if (buffer) {
					const parsed = consumeLine(buffer);
					if (parsed) yield parsed;
				}
				const parsed = consumeLine('');
				if (parsed) yield parsed;
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function appendCapped(current: string, value: string, cap: number): [string, boolean] {
	const encoder = new TextEncoder();
	const currentBytes = encoder.encode(current).byteLength;
	const remaining = Math.max(0, cap - currentBytes);
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= remaining) return [current + value, false];
	return [current + new TextDecoder().decode(bytes.slice(0, remaining)), true];
}

export async function executeInKernel(
	baseUrl: string,
	input: {
		sessionId: string;
		code: string;
		maxStdoutBytes?: number;
		maxStderrBytes?: number;
		maxOutputBytes?: number;
	},
	options: { fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<KernelExecuteResult> {
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener('abort', onAbort, { once: true });
	if (options.signal?.aborted) onAbort();
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs ?? 60_000);
	let stdout = '';
	let stderr = '';
	let output: KernelOutput | undefined;
	let truncated = false;
	let completed = false;
	let success = false;
	try {
		const response = await (options.fetchImpl ?? globalThis.fetch)(
			`${baseUrl}/api/kernel/execute`,
			{
				method: 'POST',
				headers: {
					Accept: 'text/event-stream',
					'Content-Type': 'application/json',
					'Marimo-Session-Id': input.sessionId,
				},
				body: JSON.stringify({ code: input.code }),
				signal: controller.signal,
			},
		);
		await assertKernelResponse(response, 'text/event-stream');
		if (!response.body) throw new KernelHttpError(response.status, 'Kernel response had no body');
		for await (const message of parseSseStream(response.body)) {
			let payload: unknown;
			try {
				payload = JSON.parse(message.data);
			} catch {
				continue;
			}
			const value = payload as { data?: unknown; success?: unknown; output?: unknown };
			if (message.event === 'stdout' && typeof value.data === 'string') {
				const appended = appendCapped(stdout, value.data, input.maxStdoutBytes ?? 256 * 1024);
				stdout = appended[0];
				truncated ||= appended[1];
			} else if (message.event === 'stderr' && typeof value.data === 'string') {
				const appended = appendCapped(stderr, value.data, input.maxStderrBytes ?? 256 * 1024);
				stderr = appended[0];
				truncated ||= appended[1];
			} else if (message.event === 'done') {
				completed = true;
				success = value.success === true;
				if (typeof value.output === 'object' && value.output !== null) {
					const candidate = value.output as KernelOutput;
					if (typeof candidate.mimetype === 'string') {
						const serialized =
							typeof candidate.data === 'string' ? candidate.data : JSON.stringify(candidate.data);
						const capped = appendCapped('', serialized, input.maxOutputBytes ?? 1024 * 1024);
						truncated ||= capped[1];
						output = {
							mimetype: candidate.mimetype,
							data: capped[1] ? capped[0] : candidate.data,
						};
					}
				}
			}
		}
	} catch (error) {
		if (!(error instanceof Error && error.name === 'AbortError')) throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', onAbort);
	}
	return { completed, success, stdout, stderr, ...(output ? { output } : {}), truncated, timedOut };
}
