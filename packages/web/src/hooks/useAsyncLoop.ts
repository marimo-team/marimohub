import { withAbortSignal } from '@marimo-hub/core/async';
import { sleep } from '@marimo-hub/core/duration';
import { useEffect, useEffectEvent } from 'react';

interface AsyncLoopOptions<State> {
	/** A changed key restarts the loop; null or undefined disables it. */
	key: unknown;
	initial: State;
	delay: (state: State) => number;
	/** Return null to stop. Guard post-await side effects with signal.aborted. */
	step: (state: State, signal: AbortSignal) => Promise<State | null>;
	onError: (error: Error) => void;
}

/** Delays start after the previous step settles; steps within a loop cannot overlap. */
export function useAsyncLoop<State>(options: AsyncLoopOptions<State>): void {
	const { key } = options;
	const initial = useEffectEvent(() => options.initial);
	const delay = useEffectEvent(options.delay);
	const step = useEffectEvent(options.step);
	const onError = useEffectEvent(options.onError);

	useEffect(() => {
		if (key === null || key === undefined) return;
		const controller = new AbortController();
		const { signal } = controller;
		const run = async () => {
			let state: State | null = initial();
			while (state !== null && !signal.aborted) {
				await sleep(delay(state), signal);
				if (signal.aborted) return;
				state = await withAbortSignal(step(state, signal), signal);
			}
		};
		void run().catch((error: unknown) => {
			if (!signal.aborted) onError(error instanceof Error ? error : new Error(String(error)));
		});
		return () => controller.abort();
	}, [key]);
}
