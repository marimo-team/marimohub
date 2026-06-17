/**
 * Liveness probe for a notebook kernel. On reconnect a session can still read
 * `running` while its marimo process has died (e.g. the user shut it down from the
 * notebook UI) — the sandbox container is alive, so nothing flips the status and
 * the next request 502s. The probe GETs the kernel root (not a marimo `/health`
 * path), so it needs no proxy token and no marimo-version knowledge: in `proxy`
 * mode the bare origin 404s under marimo's base-url, which still means ALIVE. Only
 * a transport failure or a gateway 5xx is DEAD. `fetch` is injected to keep `core`
 * vendor-free and the probe testable.
 */

import { sleep } from '../../duration';

export type KernelLiveness = 'alive' | 'dead';

export type KernelProbe = (url: string) => Promise<KernelLiveness>;

export interface KernelProbeOptions {
	/** Per-attempt timeout before the request is aborted. Default 2000ms. */
	timeoutMs?: number;
	/** Total attempts; DEAD only if the last one is dead. Default 2. */
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
		return 'dead';
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Returns ALIVE on the first reachable attempt; DEAD only when every attempt fails,
 * so a single ingress blip doesn't retire a healthy session.
 */
export async function probeKernelLiveness(
	url: string,
	opts: KernelProbeOptions = {},
): Promise<KernelLiveness> {
	const timeoutMs = opts.timeoutMs ?? 2000;
	const attempts = Math.max(1, opts.attempts ?? 2);
	const retryDelayMs = opts.retryDelayMs ?? 250;
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

	for (let attempt = 1; attempt <= attempts; attempt++) {
		if ((await probeOnce(url, timeoutMs, fetchImpl)) === 'alive') return 'alive';
		if (attempt < attempts) await sleep(retryDelayMs);
	}
	return 'dead';
}
