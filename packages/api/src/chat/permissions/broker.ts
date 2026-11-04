import type { PermissionDecision } from '@marimo-hub/core/chat';

export type PermissionOutcome = PermissionDecision | 'expired' | 'cancelled';

/** How long the deadline read may take before the request simply expires. */
const FINAL_READ_MS = 2000;

function bounded<T>(task: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		task.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

export function permissionKey(pid: string, cid: string, rid: string): string {
	return JSON.stringify([pid, cid, rid]);
}

/**
 * Hands consent decisions to the turn waiting on them. Same-process decisions
 * arrive immediately; decisions recorded by another replica arrive through the
 * polled `readDecision`, which reads the conversation head. A read that fails
 * never fails the turn: the wait goes on, and at the deadline the request
 * expires, so an unreadable remote decision runs nothing.
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
		return new Promise((resolve) => {
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
				let decision: PermissionOutcome | undefined;
				try {
					decision = await readDecision();
				} catch {
					decision = undefined;
				}
				if (settled) return;
				if (decision) finish(decision);
				else pollTimer = setTimeout(() => void poll(), pollMs);
			};
			const abort = () => finish('cancelled');
			this.pending.set(key, finish);
			// A decision saved by another replica just before the deadline still counts.
			const expire = async () => {
				if (settled) return;
				try {
					const decision = readDecision ? await bounded(readDecision(), FINAL_READ_MS) : undefined;
					finish(decision ?? 'expired');
				} catch {
					finish('expired');
				}
			};
			const timer = setTimeout(() => void expire(), timeoutMs);
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
