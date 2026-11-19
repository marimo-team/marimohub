import type { SandboxId } from '@marimo-hub/core/ids';
import type { SandboxStartupSnapshot } from '@marimo-hub/core/ports/sandbox';

type Progress = SandboxStartupSnapshot & { sandbox_id: SandboxId };

/** Intermediate writes require a host lifetime; final progress belongs to the status write. */
export function durableStartup(
	persist: (progress: Progress) => Promise<unknown>,
	schedule?: (task: () => Promise<void>) => void,
) {
	let latest: Progress | undefined;
	let pending: Progress | undefined;
	let state: 'buffering' | 'active' | 'closed' | 'failed' = 'buffering';
	let scheduled = false;
	let hasWrites = false;
	const drain = () => {
		if (!schedule || state !== 'active' || scheduled || !pending) return;
		scheduled = true;
		schedule(async () => {
			try {
				while (pending) {
					if (state !== 'active') break;
					const progress = pending;
					pending = undefined;
					hasWrites = true;
					await persist(progress);
				}
			} catch (error) {
				if (state !== 'closed') state = 'failed';
				throw error;
			} finally {
				scheduled = false;
			}
		});
	};
	return {
		get hasWrites() {
			return hasWrites;
		},
		report(progress: Progress) {
			if (state === 'closed') return;
			if (
				latest?.sandbox_id === progress.sandbox_id &&
				latest.attempt === progress.attempt &&
				latest.phase === progress.phase
			)
				return;
			latest = pending = progress;
			drain();
		},
		enable() {
			if (state !== 'buffering') return;
			state = 'active';
			drain();
		},
		finish() {
			state = 'closed';
			pending = undefined;
			return latest;
		},
	};
}
