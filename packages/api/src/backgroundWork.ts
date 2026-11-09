import type { BackgroundWork } from '@marimo-hub/core';

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
