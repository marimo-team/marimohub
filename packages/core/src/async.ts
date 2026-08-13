export interface DeadlineOptions {
	timeoutMs: number;
	timeoutError: () => Error;
	signal?: AbortSignal;
	abortError?: () => Error;
}

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

function assertTimerDelay(timeoutMs: number): void {
	const error = timerDelayError(timeoutMs);
	if (error) throw error;
}

function timerDelayError(timeoutMs: number): RangeError | undefined {
	return !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_DELAY_MS
		? new RangeError(`timeoutMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`)
		: undefined;
}

export function deadlineSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	assertTimerDelay(timeoutMs);
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function withAbortSignal<T>(
	work: PromiseLike<T>,
	signal?: AbortSignal,
	abortError: () => Error = () => errorFromAbortReason(signal?.reason),
): Promise<T> {
	if (!signal) return Promise.resolve(work);
	if (signal.aborted) {
		void Promise.resolve(work).catch(() => {});
		return Promise.reject(callErrorFactory(abortError));
	}
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(callErrorFactory(abortError));
		signal.addEventListener('abort', onAbort, { once: true });
	});
	return Promise.race([work, aborted]).finally(() => {
		if (onAbort) signal.removeEventListener('abort', onAbort);
	});
}

export function withDeadline<T>(
	work: PromiseLike<T> | ((signal: AbortSignal) => PromiseLike<T>),
	options: DeadlineOptions,
): Promise<T> {
	const invalidTimeout = timerDelayError(options.timeoutMs);
	if (invalidTimeout) return Promise.reject(invalidTimeout);
	if (options.signal?.aborted) {
		if (typeof work !== 'function') void Promise.resolve(work).catch(() => {});
		return Promise.reject(
			options.abortError
				? callErrorFactory(options.abortError)
				: errorFromAbortReason(options.signal.reason),
		);
	}
	const timeout = new AbortController();
	const timer = setTimeout(
		() => timeout.abort(new DOMException('The operation timed out.', 'TimeoutError')),
		options.timeoutMs,
	);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout.signal])
		: timeout.signal;
	const pending =
		typeof work === 'function' ? Promise.resolve().then(() => work(signal)) : Promise.resolve(work);
	return withAbortSignal(pending, signal, () => {
		if (timeout.signal.aborted) return callErrorFactory(options.timeoutError);
		return options.abortError
			? callErrorFactory(options.abortError)
			: errorFromAbortReason(options.signal?.reason);
	}).finally(() => clearTimeout(timer));
}

function callErrorFactory(factory: () => Error): Error {
	try {
		return factory();
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

function errorFromAbortReason(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	return new DOMException('The operation was aborted.', 'AbortError');
}
