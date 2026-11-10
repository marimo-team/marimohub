import { HTTPException } from 'hono/http-exception';
import {
	KeyedAdmission,
	noopMetrics,
	NotFoundError,
	ResourceExhaustedError,
	weakMemo,
} from '@marimo-hub/core';
import type { ObjectBody } from '@marimo-hub/core';
import type { ApiDeps } from '../context';

export {
	clearObjectCredentialCacheForTests,
	makeObjectBrowseContext,
	runObjectBrowse,
} from '../integrations/objectBrowseContext';

type DownloadLimits = NonNullable<NonNullable<ApiDeps['dataBrowser']>['objectBrowser']>;

const downloadGate = weakMemo((limits: DownloadLimits) => {
	const exhausted = () =>
		new ResourceExhaustedError('Too many object downloads are active — try again later.');
	return new KeyedAdmission<string>(
		limits.maxConcurrentDownloads,
		limits.maxConcurrentDownloadsPerUser,
		{ global: exhausted, perKey: exhausted },
	);
});

export function acquireDownload(
	deps: ApiDeps,
	userId: string,
	operation: 'download' | 'inline' = 'download',
): () => void {
	const limits = deps.dataBrowser?.objectBrowser;
	if (!limits) throw new NotFoundError('Object downloads are not enabled on this deployment.');
	const gate = downloadGate(limits);
	// The limits object is edited in place after the gate exists, so apply the current values.
	gate.reconfigure(limits.maxConcurrentDownloads, limits.maxConcurrentDownloadsPerUser);
	const tags = { operation };
	const emitter = deps.metrics ?? noopMetrics;
	let release: () => void;
	try {
		release = gate.acquire(userId);
	} catch (error) {
		emitter.increment('object_browser.download.rejected', 1, tags);
		throw error;
	}
	emitter.gauge('object_browser.download.active', gate.activeCount);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		release();
		emitter.gauge('object_browser.download.active', gate.activeCount);
	};
}

export function streamObjectBody(
	object: ObjectBody,
	release: () => void,
	onFinish: () => void,
	signal?: AbortSignal,
	onCancel?: () => void,
): ReadableStream<Uint8Array> {
	const reader = object.body.getReader();
	let finished = false;
	let closed = false;
	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
	const finish = () => {
		if (finished) return;
		finished = true;
		signal?.removeEventListener('abort', abort);
		try {
			reader.releaseLock();
		} finally {
			try {
				onFinish();
			} finally {
				release();
			}
		}
	};
	const close = () => {
		if (closed) return;
		closed = true;
		try {
			object.close();
		} finally {
			finish();
		}
	};
	const abort = () => {
		if (finished) return;
		const reason =
			signal?.reason ?? new DOMException('The object download was aborted.', 'AbortError');
		try {
			streamController?.error(reason);
		} finally {
			void reader
				.cancel(reason)
				.catch(() => {})
				.finally(close);
		}
	};
	return new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller;
			if (signal?.aborted) abort();
			else signal?.addEventListener('abort', abort, { once: true });
		},
		async pull(controller) {
			try {
				const next = await reader.read();
				if (finished) return;
				if (next.done) {
					controller.close();
					close();
				} else {
					controller.enqueue(next.value);
				}
			} catch (error) {
				if (finished) return;
				controller.error(error);
				close();
			}
		},
		async cancel(reason) {
			try {
				onCancel?.();
				await reader.cancel(reason);
			} finally {
				close();
			}
		},
	});
}

export { objectContentDisposition } from '../contentDisposition';

export function safeObjectContentType(contentType: string, inline: boolean): string {
	if (!inline) return 'application/octet-stream';
	return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(contentType)
		? contentType
		: 'application/octet-stream';
}

export function validRangeHeader(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (!/^bytes=(?:\d+-\d*|\d*-\d+)$/.test(value)) {
		throw new HTTPException(416, { message: 'Only one valid byte range is supported.' });
	}
	return value;
}
