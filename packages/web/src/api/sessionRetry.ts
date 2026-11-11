import { sleep } from '@marimo-hub/core/duration';
import { admissionRetryDelay } from './sessionRetryPolicy';

export async function retrySessionAdmission<T>(request: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await request();
		} catch (error) {
			const delay = admissionRetryDelay(error, attempt);
			if (delay === null) throw error;
			await sleep(delay);
		}
	}
}
