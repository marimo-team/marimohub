import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import type { ObjectBrowseContext, S3ObjectStoreSource } from '@marimo-hub/core';
import { ObjectBrowseError } from '@marimo-hub/core';
import {
	assertPermittedHost,
	createGuardedLookup,
	DEFAULT_OBJECT_BROWSER_LIMITS,
	isAbortError,
} from '@marimo-hub/object-browser-commons';

export { createGuardedLookup } from '@marimo-hub/object-browser-commons';
import type { GuardedHostResolver } from '@marimo-hub/object-browser-commons';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { NodeHttpHandlerOptions } from '@smithy/node-http-handler';

export type { GuardedHostResolver, PinnedAddress } from '@marimo-hub/object-browser-commons';

export interface S3ClientLike {
	send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
	destroy(): void;
}

export type S3ClientFactory = (
	source: S3ObjectStoreSource,
	context: ObjectBrowseContext,
) => S3ClientLike;

export function createS3ClientFactory(options: {
	resolveHost: GuardedHostResolver;
	connectionTimeoutMs?: number;
	requestTimeoutMs?: number;
	metadataMaxResponseBytes?: number;
	listMaxResponseBytes?: number;
}): S3ClientFactory {
	return (source, context) => {
		const lookup = createGuardedLookup(options.resolveHost, context.signal);
		const requestHandler = new MetadataCappedNodeHttpHandler(
			options.metadataMaxResponseBytes ?? DEFAULT_OBJECT_BROWSER_LIMITS.metadataMaxResponseBytes,
			options.listMaxResponseBytes ?? DEFAULT_OBJECT_BROWSER_LIMITS.listMaxResponseBytes,
			{
				httpAgent: new HttpAgent({ lookup }),
				httpsAgent: new HttpsAgent({ lookup }),
				...enforcedTimeouts(options),
			},
		);
		const credentials = credentialsFor(source, context);
		const client = new S3Client({
			region: source.region ?? context.federation?.storage.region ?? 'us-east-1',
			endpoint: source.endpoint,
			forcePathStyle: source.path_style,
			maxAttempts: 3,
			requestHandler,
			...(credentials ? { credentials } : {}),
		}) as S3ClientLike;
		const endpointAllowed = guardEndpoint(source.endpoint, options.resolveHost, context.signal);
		return {
			send: async (command, sendOptions) => {
				await endpointAllowed;
				return client.send(command, sendOptions);
			},
			destroy: () => client.destroy(),
		};
	};
}

class MetadataCappedNodeHttpHandler extends NodeHttpHandler {
	constructor(
		private readonly metadataMaxBytes: number,
		private readonly listMaxBytes: number,
		options: NodeHttpHandlerOptions,
	) {
		super(options);
	}

	override async handle(
		request: Parameters<NodeHttpHandler['handle']>[0],
		options?: Parameters<NodeHttpHandler['handle']>[1],
	) {
		const result = await super.handle(request, options);
		const maxBytes = s3ResponseLimit(request, this.metadataMaxBytes, this.listMaxBytes);
		if (maxBytes !== undefined) {
			const declaredBytes = Number(result.response.headers['content-length']);
			if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
				(result.response.body as { destroy?: () => void } | undefined)?.destroy?.();
				throw metadataResponseTooLarge();
			}
			result.response.body = boundedResponseBody(result.response.body, maxBytes);
		}
		return result;
	}
}

export function s3ResponseLimit(
	request: Parameters<NodeHttpHandler['handle']>[0],
	metadataMaxBytes: number,
	listMaxBytes: number,
): number | undefined {
	if (request.method !== 'GET') return undefined;
	const query = request.query ?? {};
	if (
		query['x-id'] === 'ListBuckets' ||
		Object.hasOwn(query, 'list-type') ||
		Object.hasOwn(query, 'versions')
	) {
		return listMaxBytes;
	}
	return Object.hasOwn(query, 'tagging') ? metadataMaxBytes : undefined;
}

function boundedResponseBody(body: unknown, maxBytes: number): unknown {
	if (body === undefined || body === null) return body;
	if (typeof body === 'string') {
		if (Buffer.byteLength(body) > maxBytes) throw metadataResponseTooLarge();
		return body;
	}
	if (body instanceof Uint8Array) {
		if (body.byteLength > maxBytes) throw metadataResponseTooLarge();
		return body;
	}
	if (body instanceof ArrayBuffer) {
		if (body.byteLength > maxBytes) throw metadataResponseTooLarge();
		return body;
	}
	if (body instanceof ReadableStream) {
		let seen = 0;
		return body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					seen += chunk.byteLength;
					if (seen > maxBytes) throw metadataResponseTooLarge();
					controller.enqueue(chunk);
				},
			}),
		);
	}
	if (typeof (body as { pipe?: unknown }).pipe === 'function') {
		return (body as NodeJS.ReadableStream).pipe(new BoundedMetadataTransform(maxBytes));
	}
	return body;
}

class BoundedMetadataTransform extends Transform {
	private seen = 0;

	constructor(private readonly maxBytes: number) {
		super();
	}

	_transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
		this.seen += typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
		if (this.seen > this.maxBytes) callback(metadataResponseTooLarge());
		else callback(null, chunk);
	}
}

function metadataResponseTooLarge(): ObjectBrowseError {
	return new ObjectBrowseError('unavailable', 'The object-store metadata response was too large.');
}

/**
 * The pinned `lookup` is skipped for IP-literal endpoints, so a custom endpoint
 * could otherwise reach any address. Checked once per client, awaited by every
 * command so no request path can skip it.
 */
function guardEndpoint(
	endpoint: string | undefined,
	resolveHost: GuardedHostResolver,
	signal?: AbortSignal,
): Promise<void> {
	if (!endpoint) return Promise.resolve();
	let hostname: string;
	try {
		hostname = new URL(endpoint).hostname;
	} catch {
		return rejected('The object-store endpoint is invalid.');
	}
	const guard = assertPermittedHost(hostname, resolveHost, signal).catch((error: unknown) => {
		if (isAbortError(error) || signal?.aborted) {
			throw new ObjectBrowseError('aborted', 'The request was canceled.');
		}
		throw new ObjectBrowseError(
			'access_denied',
			'The object-store endpoint is not permitted from this deployment.',
		);
	});
	// The first command may be issued well after the check settles.
	guard.catch(() => {});
	return guard;
}

function rejected(message: string): Promise<never> {
	const failure = Promise.reject(new ObjectBrowseError('access_denied', message));
	failure.catch(() => {});
	return failure;
}

export function enforcedTimeouts(options: {
	connectionTimeoutMs?: number;
	requestTimeoutMs?: number;
}) {
	return {
		connectionTimeout: options.connectionTimeoutMs ?? 10_000,
		requestTimeout: options.requestTimeoutMs ?? 30_000,
		throwOnRequestTimeout: true,
	} as const;
}

export function credentialsFor(source: S3ObjectStoreSource, context: ObjectBrowseContext) {
	if (source.auth.method === 'static') {
		return {
			accessKeyId: source.auth.access_key_id,
			secretAccessKey: source.auth.secret_access_key,
			sessionToken: source.auth.session_token,
		};
	}
	if (context.federation?.provider === 's3') {
		if (!endpointsMatch(source.endpoint, context.federation.storage.endpoint)) {
			throw new ObjectBrowseError(
				'access_denied',
				'Federated credentials are not valid for this object-store endpoint.',
			);
		}
		return {
			accessKeyId: context.federation.credentials.accessKeyId,
			secretAccessKey: context.federation.credentials.secretAccessKey,
			sessionToken: context.federation.credentials.sessionToken,
		};
	}
	if (!context.allow_server_ambient.s3) {
		throw new ObjectBrowseError(
			'access_denied',
			'Ambient object-store access is not enabled for this integration.',
		);
	}
	return;
}

export function endpointsMatch(left: string | undefined, right: string | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	try {
		return new URL(left).origin === new URL(right).origin;
	} catch {
		return false;
	}
}
