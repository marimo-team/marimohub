export interface DeadlineOptions {
	timeoutMs: number;
	timeoutError: () => Error;
}

export function withDeadline<T>(work: Promise<T>, options: DeadlineOptions): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			try {
				reject(options.timeoutError());
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		}, options.timeoutMs);
	});
	return Promise.race([work, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}
