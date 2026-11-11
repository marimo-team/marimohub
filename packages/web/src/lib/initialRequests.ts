import { withAbortSignal } from '@marimo-hub/core/async';

declare global {
	interface Window {
		__MARIMOHUB_PREFETCH__?: {
			createdAt: number;
			responses: Record<string, Promise<Response | null>>;
		};
	}
}

export async function consumeInitialRequest(input: string, signal?: AbortSignal) {
	const cache = window.__MARIMOHUB_PREFETCH__;
	if (!cache) return;
	if (Date.now() - cache.createdAt > 30_000) {
		delete window.__MARIMOHUB_PREFETCH__;
		return;
	}
	const url = new URL(input, window.location.href);
	if (url.origin !== window.location.origin) return;
	url.searchParams.sort();
	const pending = cache.responses[url.href];
	delete cache.responses[url.href];
	if (pending === undefined) return;
	const response = await withAbortSignal(
		pending.catch(() => null),
		signal,
	);
	return response?.ok ? response : undefined;
}
