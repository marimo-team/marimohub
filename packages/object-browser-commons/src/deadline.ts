import { deadlineSignal } from '@marimo-hub/core';
import type { ObjectBrowseContext } from '@marimo-hub/core';

export async function withOperationDeadline<T>(
	context: ObjectBrowseContext,
	timeoutMs: number,
	run: (context: ObjectBrowseContext) => Promise<T>,
): Promise<T> {
	return run({ ...context, signal: deadlineSignal(timeoutMs, context.signal) });
}
