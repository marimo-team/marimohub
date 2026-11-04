import type { PermissionDecision } from '@marimo-hub/core/chat';

export type PermissionOutcome = PermissionDecision | 'expired' | 'cancelled';

export function permissionKey(pid: string, cid: string, rid: string): string {
	return JSON.stringify([pid, cid, rid]);
}

/**
 * Hands consent decisions to the turn waiting on them. Same-process decisions
 * arrive immediately; decisions recorded by another replica arrive through the
 * polled `readDecision`, which reads the conversation head.
 */
export class PermissionBroker {
	private readonly pending = new Map<string, (decision: PermissionOutcome) => void>();

	wait(
		key: string,
		options: {
			timeoutMs: number;
			pollMs?: number;
			signal?: AbortSignal;
			readDecision?: () => Promise<PermissionOutcome | undefined>;
		},
	): Promise<PermissionOutcome> {
		if (this.pending.has(key)) throw new Error('Permission request is already pending');
		const { timeoutMs, signal, readDecision } = options;
		const pollMs = options.pollMs ?? 1000;
		return new Promise((resolve, reject) => {
			let settled = false;
			let pollTimer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				settled = true;
				clearTimeout(timer);
				if (pollTimer !== undefined) clearTimeout(pollTimer);
				signal?.removeEventListener('abort', abort);
				this.pending.delete(key);
			};
			const finish = (decision: PermissionOutcome) => {
				if (settled) return;
				cleanup();
				resolve(decision);
			};
			const poll = async () => {
				if (!readDecision) return;
				try {
					const decision = await readDecision();
					if (settled) return;
					if (decision) finish(decision);
					else pollTimer = setTimeout(() => void poll(), pollMs);
				} catch (error) {
					if (settled) return;
					cleanup();
					reject(
						error instanceof Error
							? error
							: new Error('Could not read the permission decision', { cause: error }),
					);
				}
			};
			const abort = () => finish('cancelled');
			this.pending.set(key, finish);
			const timer = setTimeout(() => finish('expired'), timeoutMs);
			signal?.addEventListener('abort', abort, { once: true });
			if (signal?.aborted) abort();
			if (!settled && readDecision) pollTimer = setTimeout(() => void poll(), pollMs);
		});
	}

	decide(key: string, decision: PermissionDecision): boolean {
		const finish = this.pending.get(key);
		if (!finish) return false;
		finish(decision);
		return true;
	}
}

export const permissionBroker = new PermissionBroker();
