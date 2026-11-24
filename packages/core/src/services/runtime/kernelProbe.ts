/**
 * Liveness probe for a notebook kernel. On reconnect a session can still read
 * `running` while its marimo process has died (e.g. the user shut it down from the
 * notebook UI) — the sandbox container is alive, so nothing flips the status and
 * the next request 502s. The probe GETs the kernel root (not a marimo `/health`
 * path), so it needs no proxy token and no marimo-version knowledge: in `proxy`
 * mode the bare origin 404s under marimo's base-url, which still means ALIVE. Only
 * a refused connection or a gateway 5xx is DEAD. A timeout is UNRESPONSIVE: marimo
 * serves HTTP on the kernel's Python process, so a cell holding the GIL (for
 * example an app session running its cells on open) stalls the server for seconds
 * while the kernel is healthy. Callers that retire a shared session act on DEAD
 * only. `fetch` is injected to keep `core` vendor-free and the probe testable.
 */

import { sleep } from '../../duration';

export type KernelLiveness = 'alive' | 'unresponsive' | 'dead';

export type KernelProbe = (url: string) => Promise<KernelLiveness>;

export interface KernelProbeOptions {
	/** Per-attempt timeout before the request is aborted. Default 2000ms. */
	timeoutMs?: number;
	/** Total attempts before giving up. Default 2. */
	attempts?: number;
	/** Delay between attempts. Default 250ms. */
	retryDelayMs?: number;
	/** Defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch;
}

/** Gateway statuses meaning the upstream kernel is down (not the kernel itself answering). */
const GATEWAY_DOWN = new Set([502, 503, 504]);

async function probeOnce(
	url: string,
	timeoutMs: number,
	fetchImpl: typeof fetch,
): Promise<KernelLiveness> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetchImpl(url, {
			method: 'GET',
			redirect: 'manual',
			signal: controller.signal,
		});
		return GATEWAY_DOWN.has(res.status) ? 'dead' : 'alive';
	} catch {
		return controller.signal.aborted ? 'unresponsive' : 'dead';
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Returns ALIVE on the first reachable attempt, so a single ingress blip doesn't
 * retire a healthy session. Otherwise DEAD if any attempt was refused, and
 * UNRESPONSIVE if every attempt timed out.
 */
export async function probeKernelLiveness(
	url: string,
	opts: KernelProbeOptions = {},
): Promise<KernelLiveness> {
	const timeoutMs = opts.timeoutMs ?? 2000;
	const attempts = Math.max(1, opts.attempts ?? 2);
	const retryDelayMs = opts.retryDelayMs ?? 250;
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

	let sawDeadAttempt = false;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const result = await probeOnce(url, timeoutMs, fetchImpl);
		if (result === 'alive') return 'alive';
		if (result === 'dead') sawDeadAttempt = true;
		if (attempt < attempts) await sleep(retryDelayMs);
	}
	return sawDeadAttempt ? 'dead' : 'unresponsive';
}
