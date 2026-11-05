function abortError(signal?: AbortSignal): Error {
	const reason: unknown = signal?.reason;
	if (reason instanceof Error) return reason;
	return new DOMException('The operation was aborted.', 'AbortError');
}

export function withAbortSignal<T>(work: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return Promise.resolve(work);
	if (signal.aborted) {
		void Promise.resolve(work).catch(() => {});
		return Promise.reject(abortError(signal));
	}
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(abortError(signal));
		signal.addEventListener('abort', onAbort, { once: true });
	});
	return Promise.race([work, aborted]).finally(() => {
		if (onAbort) signal.removeEventListener('abort', onAbort);
	});
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await withAbortSignal(
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, ms);
			}),
			signal,
		);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
