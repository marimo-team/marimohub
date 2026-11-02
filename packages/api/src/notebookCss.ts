import { BoundedLruMap, UnavailableError } from '@marimo-hub/core';
import type { ThemeConfig } from '@marimo-hub/core/theme';

const MAX_BYTES = 64 * 1024;
const REVALIDATE_MS = 60_000;

interface Entry {
	css: string;
	etag?: string;
	checkedAt: number;
}

export class NotebookCssCache {
	private readonly entries = new BoundedLruMap<string, Entry>(8);
	private readonly pending = new Map<string, Promise<string>>();

	constructor(private readonly now: () => number = Date.now) {}

	get(url: string): Promise<string> {
		const cached = this.entries.get(url);
		if (cached && this.now() - cached.checkedAt < REVALIDATE_MS) return Promise.resolve(cached.css);
		const pending = this.pending.get(url);
		if (pending) return pending;
		const request = this.load(url, cached).finally(() => this.pending.delete(url));
		this.pending.set(url, request);
		return request;
	}

	private async load(url: string, cached?: Entry): Promise<string> {
		try {
			const response = await fetch(url, {
				headers: cached?.etag ? { 'If-None-Match': cached.etag } : {},
				signal: AbortSignal.timeout(5000),
				redirect: 'error',
			});
			if (response.status === 304 && cached) {
				this.entries.set(url, { ...cached, checkedAt: this.now() });
				return cached.css;
			}
			if (!response.ok || !response.body) {
				await response.body?.cancel();
				throw new Error('CSS response unavailable');
			}
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > MAX_BYTES) throw new Error('CSS exceeds 64 KiB');
					chunks.push(value);
				}
			} finally {
				try {
					await reader.cancel();
				} finally {
					reader.releaseLock();
				}
			}
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			const css = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
			this.entries.set(url, {
				css,
				etag: response.headers.get('etag') ?? undefined,
				checkedAt: this.now(),
			});
			return css;
		} catch {
			throw new UnavailableError(
				'Unable to load deployment notebook CSS. Check MARIMOHUB_THEME_NOTEBOOK_CSS (UTF-8, at most 64 KiB, no redirects).',
			);
		}
	}
}

export function notebookCssUrl(href: string, appBaseUrl?: string): string {
	// A request Host header must never choose the destination of a server-side fetch.
	if (href.startsWith('/') && !appBaseUrl?.trim()) {
		throw new UnavailableError(
			'Root-relative MARIMOHUB_THEME_NOTEBOOK_CSS requires MARIMOHUB_APP_BASE_URL.',
		);
	}
	try {
		return new URL(href, href.startsWith('/') ? appBaseUrl : undefined).href;
	} catch (cause) {
		throw new UnavailableError(
			'Unable to resolve deployment notebook CSS. Check MARIMOHUB_THEME_NOTEBOOK_CSS and MARIMOHUB_APP_BASE_URL.',
			{ cause },
		);
	}
}

const caches = new WeakMap<ThemeConfig, NotebookCssCache>();
export function notebookCssCacheFor(theme: ThemeConfig): NotebookCssCache {
	let cache = caches.get(theme);
	if (!cache) {
		cache = new NotebookCssCache();
		caches.set(theme, cache);
	}
	return cache;
}
