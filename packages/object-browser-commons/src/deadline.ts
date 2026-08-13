import type { ObjectBrowseContext } from '@marimo-hub/core';

export async function withOperationDeadline<T>(
	context: ObjectBrowseContext,
	timeoutMs: number,
	run: (context: ObjectBrowseContext) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (context.signal?.aborted) abort();
	else context.signal?.addEventListener('abort', abort, { once: true });
	const timer = setTimeout(abort, timeoutMs);
	try {
		return await run({ ...context, signal: controller.signal });
	} finally {
		clearTimeout(timer);
		context.signal?.removeEventListener('abort', abort);
	}
}
