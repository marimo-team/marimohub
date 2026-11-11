import { sleep } from '@marimo-hub/core/duration';
import { admissionRetryDelay } from './sessionRetryPolicy';

export async function retrySessionAdmission<T>(
	request: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		try {
			return await request();
		} catch (error) {
			signal?.throwIfAborted();
			const delay = admissionRetryDelay(error, attempt);
			if (delay === null) throw error;
			await sleep(delay, signal);
		}
	}
}
