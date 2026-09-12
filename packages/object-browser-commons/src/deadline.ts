import { deadlineSignal } from '@marimo-hub/core/async';
import type { ObjectBrowseContext } from '@marimo-hub/core/ports/object-browser';

export async function withOperationDeadline<T>(
	context: ObjectBrowseContext,
	timeoutMs: number,
	run: (context: ObjectBrowseContext) => Promise<T>,
): Promise<T> {
	return run({ ...context, signal: deadlineSignal(timeoutMs, context.signal) });
}
