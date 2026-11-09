import type { BackgroundWork } from '@marimo-hub/core';
import type { ApiDeps } from './context';

export function backgroundWorkFor(
	deps: Pick<ApiDeps, 'backgroundWork' | 'backgroundTasks'>,
): BackgroundWork | undefined {
	return (
		deps.backgroundWork ??
		(deps.backgroundTasks
			? {
					defer: (_label, task) => deps.backgroundTasks!.defer(Promise.resolve().then(task)),
				}
			: undefined)
	);
}

export function withInlineFallback(work: BackgroundWork | undefined): BackgroundWork | undefined {
	if (!work) return undefined;
	return {
		async defer(label, task) {
			let execution: Promise<unknown> | undefined;
			// A scheduler can retain or start work before throwing.
			const run = () => (execution ??= Promise.resolve().then(task));
			try {
				await work.defer(label, run);
			} catch (error) {
				await run();
				throw error;
			}
		},
	};
}
