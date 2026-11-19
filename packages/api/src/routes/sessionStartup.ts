import type { SandboxId } from '@marimo-hub/core';
import { SANDBOX_STARTUP_PHASES, STARTUP_DETAIL_MAX_LENGTH } from '@marimo-hub/core/constants';
import type {
	SandboxStartupProgress,
	SandboxStartupSnapshot,
} from '@marimo-hub/core/ports/sandbox';

export function sessionStartupReporter(
	emit?: (progress: SandboxStartupSnapshot, sandboxId: SandboxId) => void,
) {
	let sandbox: SandboxId | undefined;
	let attempt = 0;
	let current: SandboxStartupSnapshot | undefined;
	let closed = false;
	return {
		forSandbox(id: SandboxId) {
			if (sandbox !== id) {
				sandbox = id;
				attempt++;
				current = undefined;
			}
			return (progress: SandboxStartupProgress) => {
				if (!emit || closed || sandbox !== id || !SANDBOX_STARTUP_PHASES.includes(progress.phase))
					return;
				if (
					current &&
					SANDBOX_STARTUP_PHASES.indexOf(progress.phase) <
						SANDBOX_STARTUP_PHASES.indexOf(current.phase)
				)
					return;
				const detail =
					progress.detail?.replaceAll(/\p{Cc}/gu, ' ').slice(0, STARTUP_DETAIL_MAX_LENGTH) ||
					undefined;
				if (current?.phase === progress.phase && current.detail === detail) return;
				current = {
					phase: progress.phase,
					detail,
					attempt,
					started_at:
						current?.phase === progress.phase ? current.started_at : new Date().toISOString(),
					observed: [...new Set([...(current?.observed ?? []), progress.phase])],
				};
				try {
					emit(current, id);
				} catch {
					/* Observation must not interrupt provisioning. */
				}
			};
		},
		close() {
			closed = true;
		},
	};
}
