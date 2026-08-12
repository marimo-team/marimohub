import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { V4MAPPED } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { S3Client } from '@aws-sdk/client-s3';
import type { ObjectBrowseContext, ObjectStoreSource } from '@marimo-hub/core';
import { ObjectBrowseError } from '@marimo-hub/core';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface PinnedAddress {
	address: string;
	family: number;
}

export type GuardedHostResolver = (hostname: string) => Promise<PinnedAddress[]>;

export interface S3ClientLike {
	send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
	destroy(): void;
}

export type S3ClientFactory = (
	source: ObjectStoreSource,
	context: ObjectBrowseContext,
) => S3ClientLike;

export function createS3ClientFactory(options: {
	resolveHost: GuardedHostResolver;
	connectionTimeoutMs?: number;
	requestTimeoutMs?: number;
}): S3ClientFactory {
	return (source, context) => {
		const lookup = createGuardedLookup(options.resolveHost);
		const requestHandler = new NodeHttpHandler({
			httpAgent: new HttpAgent({ lookup }),
			httpsAgent: new HttpsAgent({ lookup }),
			...enforcedTimeouts(options),
		});
		const credentials = credentialsFor(source, context);
		return new S3Client({
			region: source.region ?? context.temporary_storage?.region ?? 'us-east-1',
			endpoint: source.endpoint,
			forcePathStyle: source.path_style,
			maxAttempts: 3,
			requestHandler,
			...(credentials ? { credentials } : {}),
		}) as unknown as S3ClientLike;
	};
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

export function credentialsFor(source: ObjectStoreSource, context: ObjectBrowseContext) {
	if (source.auth.method === 'static') {
		return {
			accessKeyId: source.auth.access_key_id,
			secretAccessKey: source.auth.secret_access_key,
			sessionToken: source.auth.session_token,
		};
	}
	if (context.temporary_s3_credentials) {
		if (!endpointsMatch(source.endpoint, context.temporary_storage?.endpoint)) {
			throw new ObjectBrowseError(
				'access_denied',
				'Federated credentials are not valid for this object-store endpoint.',
			);
		}
		return {
			accessKeyId: context.temporary_s3_credentials.accessKeyId,
			secretAccessKey: context.temporary_s3_credentials.secretAccessKey,
			sessionToken: context.temporary_s3_credentials.sessionToken,
		};
	}
	if (!context.allow_server_ambient) {
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

export function createGuardedLookup(resolveHost: GuardedHostResolver): LookupFunction {
	return ((hostname: string, lookupOptions: unknown, callback: unknown) => {
		const cb = callback as (err: Error | null, address?: unknown, family?: number) => void;
		void resolveHost(hostname).then(
			(addresses) => {
				const options =
					typeof lookupOptions === 'object' && lookupOptions !== null
						? (lookupOptions as { all?: boolean; family?: number; hints?: number })
						: {};
				const requestedFamily = options.family === 4 || options.family === 6 ? options.family : 0;
				let candidates = requestedFamily
					? addresses.filter((address) => address.family === requestedFamily)
					: addresses;
				if (
					requestedFamily === 6 &&
					candidates.length === 0 &&
					((options.hints ?? 0) & V4MAPPED) !== 0
				) {
					candidates = addresses
						.filter((address) => address.family === 4)
						.map((address) => ({ address: `::ffff:${address.address}`, family: 6 }));
				}
				if (candidates.length === 0) {
					cb(new Error('The object-store hostname did not resolve.'));
					return;
				}
				if (options.all) {
					cb(null, candidates);
				} else {
					cb(null, candidates[0].address, candidates[0].family);
				}
			},
			() => cb(new Error('The object-store hostname is not permitted.')),
		);
	}) as LookupFunction;
}
