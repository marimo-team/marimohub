import { HTTPException } from 'hono/http-exception';
import {
	createSessionId,
	exchangeFederatedStorageCredentials,
	ForbiddenError,
	noopMetrics,
	NotFoundError,
	ObjectBrowseError,
	PreconditionFailedError,
	ResourceExhaustedError,
	UnavailableError,
	ValidationError,
} from '@marimo-hub/core';
import type {
	AuthUser,
	ObjectBody,
	ObjectBrowseContext,
	Project,
	TempS3Creds,
} from '@marimo-hub/core';
import type { ApiDeps } from '../context';

const CACHE_REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_CREDENTIAL_CACHE_ENTRIES = 256;

interface CachedCredentials {
	credentials: TempS3Creds;
	expiresAt: number;
}

const credentials = new Map<string, CachedCredentials>();
const credentialLoads = new Map<string, Promise<TempS3Creds | undefined>>();

export async function makeObjectBrowseContext(
	deps: ApiDeps,
	project: Project,
	user: AuthUser,
	signal?: AbortSignal,
	options: {
		integrationId?: string;
		includeFederated?: boolean;
		allowServerAmbient?: boolean;
		disableS3Ambient?: boolean;
	} = {},
): Promise<ObjectBrowseContext> {
	const browser = deps.dataBrowser?.objectBrowser;
	const wif =
		options.includeFederated !== false && project.federation?.enabled ? deps.wif : undefined;
	const context: ObjectBrowseContext = {
		project_id: project.id,
		user_id: user.id,
		user_email: user.email,
		allow_server_ambient: {
			s3:
				wif || options.disableS3Ambient
					? false
					: (options.allowServerAmbient ?? browser?.allowServerAmbientCredentials ?? false),
			gcs: options.allowServerAmbient ?? browser?.allowServerAmbientCredentials ?? false,
			azure_blob: options.allowServerAmbient ?? browser?.allowServerAmbientCredentials ?? false,
		},
		...(signal ? { signal } : {}),
	};
	if (!wif) {
		return context;
	}

	const temporary = await cachedFederatedCredentials(
		deps,
		project.id,
		user.id,
		options.integrationId,
	);
	return temporary
		? {
				...context,
				federation: {
					provider: 's3',
					credentials: temporary,
					storage: wif.target.storage,
				},
			}
		: context;
}

async function cachedFederatedCredentials(
	deps: ApiDeps,
	projectId: Project['id'],
	userId: AuthUser['id'],
	integrationId?: string,
): Promise<TempS3Creds | undefined> {
	const wif = deps.wif;
	if (!wif) return undefined;
	const key = JSON.stringify([
		projectId,
		userId,
		integrationId ?? null,
		wif.target.audience,
		wif.target.storage.endpoint ?? null,
		wif.target.storage.region ?? null,
	]);
	const now = Date.now();
	const cached = credentials.get(key);
	if (cached && cached.expiresAt - CACHE_REFRESH_SKEW_MS > now) return cached.credentials;
	if (cached) credentials.delete(key);

	const pending = credentialLoads.get(key);
	if (pending) return pending;
	const load = exchangeFederatedStorageCredentials(
		wif.issuer,
		wif.issuerUrl,
		wif.target,
		projectId,
		createSessionId(),
	)
		.then((value) => {
			const expiresAt = value.expiration ? Date.parse(value.expiration) : Number.NaN;
			if (Number.isFinite(expiresAt) && expiresAt - CACHE_REFRESH_SKEW_MS > Date.now()) {
				sweepCredentialCache(Date.now());
				credentials.set(key, { credentials: value, expiresAt });
			}
			return value;
		})
		.catch((): undefined => {})
		.finally(() => credentialLoads.delete(key));
	credentialLoads.set(key, load);
	return load;
}

function sweepCredentialCache(now: number): void {
	for (const [key, cached] of credentials) {
		if (cached.expiresAt <= now) credentials.delete(key);
	}
	while (credentials.size >= MAX_CREDENTIAL_CACHE_ENTRIES) {
		const oldest = credentials.keys().next().value;
		if (oldest === undefined) break;
		credentials.delete(oldest);
	}
}

export function clearObjectCredentialCacheForTests(): void {
	credentials.clear();
	credentialLoads.clear();
}

export async function runObjectBrowse<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (!(error instanceof ObjectBrowseError)) throw error;
		switch (error.code) {
			case 'access_denied':
				throw new ForbiddenError(error.message);
			case 'not_found':
				throw new NotFoundError(error.message);
			case 'precondition_failed':
				throw new PreconditionFailedError(error.message);
			case 'range_not_satisfiable':
				throw new HTTPException(416, { message: error.message });
			case 'invalid_cursor':
			case 'unsupported':
				throw new ValidationError(error.message);
			case 'aborted':
			case 'unavailable':
				throw new UnavailableError(error.message);
		}
	}
}

interface DownloadLimits {
	maxConcurrentDownloads: number;
	maxConcurrentDownloadsPerUser: number;
}

class DownloadGate {
	private active = 0;
	private readonly activeByUser = new Map<string, number>();

	constructor(private readonly limits: DownloadLimits) {}

	acquire(
		userId: string,
		operation: 'download' | 'inline',
		metrics: ApiDeps['metrics'],
	): () => void {
		const tags = { operation };
		const emitter = metrics ?? noopMetrics;
		const userActive = this.activeByUser.get(userId) ?? 0;
		if (
			this.active >= this.limits.maxConcurrentDownloads ||
			userActive >= this.limits.maxConcurrentDownloadsPerUser
		) {
			emitter.increment('object_browser.download.rejected', 1, tags);
			throw new ResourceExhaustedError('Too many object downloads are active — try again later.');
		}
		this.active += 1;
		this.activeByUser.set(userId, userActive + 1);
		emitter.gauge('object_browser.download.active', this.active);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active -= 1;
			emitter.gauge('object_browser.download.active', this.active);
			const remaining = (this.activeByUser.get(userId) ?? 1) - 1;
			if (remaining === 0) this.activeByUser.delete(userId);
			else this.activeByUser.set(userId, remaining);
		};
	}
}

const downloadGates = new WeakMap<object, DownloadGate>();

export function acquireDownload(
	deps: ApiDeps,
	userId: string,
	operation: 'download' | 'inline' = 'download',
): () => void {
	const limits = deps.dataBrowser?.objectBrowser;
	if (!limits) throw new NotFoundError('Object downloads are not enabled on this deployment.');
	let gate = downloadGates.get(limits);
	if (!gate) {
		gate = new DownloadGate(limits);
		downloadGates.set(limits, gate);
	}
	return gate.acquire(userId, operation, deps.metrics);
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
	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
	const finish = () => {
		if (finished) return;
		finished = true;
		signal?.removeEventListener('abort', abort);
		try {
			onFinish();
		} finally {
			release();
		}
	};
	const close = () => {
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
			void reader.cancel(reason).catch(() => {});
			close();
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
					finish();
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

export function objectContentDisposition(key: string, inline: boolean): string {
	const last = key.split('/').at(-1) || 'download';
	const safe =
		Array.from(last, (character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127 || character === '/' || character === '\\' ? '_' : character;
		})
			.slice(0, 255)
			.join('') || 'download';
	const fallback =
		safe
			.normalize('NFKD')
			.replaceAll(/[^\x20-\x7e]/g, '_')
			.replaceAll(/["%;]/g, '_')
			.slice(0, 150) || 'download';
	const encoded = encodeURIComponent(safe).replaceAll(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

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
