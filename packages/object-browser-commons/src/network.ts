export interface PinnedAddress {
	address: string;
	family: number;
}

export type GuardedHostResolver = (
	hostname: string,
	signal?: AbortSignal,
) => Promise<PinnedAddress[]>;

export interface GuardedFetchOptions {
	socketTimeoutMs?: number;
}

const DEFAULT_SOCKET_TIMEOUT_MS = 30_000;

/**
 * Node bypasses a custom `lookup` when the host is already an IP literal, so
 * the pinning hook never sees those connections and the address policy goes
 * unenforced for them. Literals have to be checked directly.
 */
export async function assertPermittedHost(
	hostname: string,
	resolveHost: GuardedHostResolver,
	signal?: AbortSignal,
): Promise<void> {
	// A URL brackets an IPv6 literal; strip them for isIP and the resolver.
	const bare = hostname.replaceAll(/^\[|\]$/g, '');
	if (isIP(bare) === 0) return;
	const addresses = await resolveHost(bare, signal);
	if (addresses.length === 0) throw new Error('The object-store hostname did not resolve.');
}

export function createGuardedFetch(
	resolveHost: GuardedHostResolver,
	options: GuardedFetchOptions = {},
): typeof fetch {
	const socketTimeoutMs = options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;
	if (!Number.isSafeInteger(socketTimeoutMs) || socketTimeoutMs < 1) {
		throw new RangeError('Object-store socket timeout must be a positive integer');
	}
	return (async (input: URL | RequestInfo, init: RequestInit = {}) => {
		const effective = new Request(input, init);
		const url = new URL(effective.url);
		await assertPermittedHost(url.hostname, resolveHost, effective.signal);
		const lookup = createGuardedLookup(resolveHost, effective.signal);
		const request = url.protocol === 'http:' ? httpRequest : httpsRequest;
		const body = effective.body ? new Uint8Array(await effective.arrayBuffer()) : undefined;
		return new Promise<Response>((resolve, reject) => {
			const onRequestTimeout = () => {
				outgoing.destroy(new Error('The object-store request timed out.'));
			};
			const outgoing = request(
				url,
				{
					method: effective.method,
					headers: Object.fromEntries(effective.headers),
					lookup,
					signal: effective.signal,
				},
				(incoming) => {
					outgoing.setTimeout(0);
					outgoing.removeListener('timeout', onRequestTimeout);
					incoming.setTimeout(socketTimeoutMs, () => {
						incoming.destroy(new Error('The object-store response timed out.'));
					});
					const headers = new Headers();
					for (const [name, value] of Object.entries(incoming.headers)) {
						if (Array.isArray(value)) for (const child of value) headers.append(name, child);
						else if (value !== undefined) headers.set(name, value);
					}
					const responseBody =
						effective.method === 'HEAD' ||
						incoming.statusCode === 204 ||
						incoming.statusCode === 304
							? null
							: (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
					resolve(
						new Response(responseBody, {
							status: incoming.statusCode ?? 500,
							statusText: incoming.statusMessage,
							headers,
						}),
					);
				},
			);
			outgoing.setTimeout(socketTimeoutMs, onRequestTimeout);
			outgoing.on('error', reject);
			writeBody(outgoing, body);
		});
	}) as typeof fetch;
}

export function createGuardedLookup(
	resolveHost: GuardedHostResolver,
	signal?: AbortSignal,
): LookupFunction {
	return ((hostname: string, options: unknown, callback: unknown) => {
		const cb = callback as (error: Error | null, address?: unknown, family?: number) => void;
		void resolveHost(hostname, signal).then(
			(addresses) => {
				const value =
					typeof options === 'object' && options !== null
						? (options as { all?: boolean; family?: number; hints?: number })
						: typeof options === 'number'
							? { family: options }
							: {};
				const requestedFamily = value.family === 4 || value.family === 6 ? value.family : 0;
				let candidates = requestedFamily
					? addresses.filter(({ family }) => family === requestedFamily)
					: addresses;
				const hints = value.hints ?? 0;
				if (requestedFamily === 6 && (hints & V4MAPPED) !== 0) {
					const includeMapped = candidates.length === 0 || (hints & ALL) !== 0;
					if (includeMapped) {
						candidates = [
							...candidates,
							...addresses
								.filter(({ family }) => family === 4)
								.map(({ address }) => ({ address: `::ffff:${address}`, family: 6 })),
						];
					}
				}
				if (candidates.length === 0) {
					cb(new Error('The object-store hostname did not resolve.'));
				} else if (value.all) {
					cb(null, candidates);
				} else {
					cb(null, candidates[0].address, candidates[0].family);
				}
			},
			(error) => {
				const aborted =
					(error as { name?: unknown } | null)?.name === 'AbortError' || signal?.aborted;
				const mapped = new Error(
					aborted
						? 'The object-store hostname resolution was canceled.'
						: 'The object-store hostname is not permitted.',
				);
				if (aborted) mapped.name = 'AbortError';
				cb(mapped);
			},
		);
	}) as LookupFunction;
}

export function createPinnedLookup(pinned: PinnedAddress[]): LookupFunction {
	return ((_hostname: string, lookupOptions: unknown, callback: unknown) => {
		const cb = callback as (error: Error | null, address: unknown, family?: number) => void;
		if (typeof lookupOptions === 'object' && (lookupOptions as { all?: boolean } | null)?.all) {
			cb(null, pinned);
		} else {
			cb(null, pinned[0].address, pinned[0].family);
		}
	}) as LookupFunction;
}

function writeBody(
	request: ReturnType<typeof httpRequest>,
	body: BodyInit | null | undefined,
): void {
	if (body === undefined || body === null) {
		request.end();
		return;
	}
	if (typeof body === 'string' || body instanceof Uint8Array) {
		request.end(body);
		return;
	}
	if (body instanceof URLSearchParams) {
		request.end(body.toString());
		return;
	}
	request.destroy(new Error('The object-store request body is unsupported.'));
}
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { ALL, V4MAPPED } from 'node:dns';
