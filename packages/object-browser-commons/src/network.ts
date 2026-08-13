export interface PinnedAddress {
	address: string;
	family: number;
}

export type GuardedHostResolver = (
	hostname: string,
	signal?: AbortSignal,
) => Promise<PinnedAddress[]>;

export function createGuardedFetch(resolveHost: GuardedHostResolver): typeof fetch {
	return (async (input: URL | RequestInfo, init: RequestInit = {}) => {
		const effective = new Request(input, init);
		const url = new URL(effective.url);
		const lookup = createLookup(resolveHost, effective.signal);
		const request = url.protocol === 'http:' ? httpRequest : httpsRequest;
		const body = effective.body ? new Uint8Array(await effective.arrayBuffer()) : undefined;
		return new Promise<Response>((resolve, reject) => {
			const outgoing = request(
				url,
				{
					method: effective.method,
					headers: Object.fromEntries(effective.headers),
					lookup,
					signal: effective.signal,
				},
				(incoming) => {
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
			outgoing.on('error', reject);
			writeBody(outgoing, body);
		});
	}) as typeof fetch;
}

function createLookup(resolveHost: GuardedHostResolver, signal?: AbortSignal): LookupFunction {
	return ((hostname: string, options: unknown, callback: unknown) => {
		const cb = callback as (error: Error | null, address?: unknown, family?: number) => void;
		void resolveHost(hostname, signal).then(
			(addresses) => {
				const value =
					typeof options === 'object' && options !== null
						? (options as { all?: boolean; family?: number })
						: typeof options === 'number'
							? { family: options }
							: {};
				const candidates =
					value.family === 4 || value.family === 6
						? addresses.filter(({ family }) => family === value.family)
						: addresses;
				if (candidates.length === 0) {
					cb(new Error('The object-store hostname did not resolve.'));
				} else if (value.all) {
					cb(null, candidates);
				} else {
					cb(null, candidates[0].address, candidates[0].family);
				}
			},
			(error) => {
				const mapped = new Error('The object-store hostname is not permitted.');
				if ((error as { name?: unknown } | null)?.name === 'AbortError' || signal?.aborted) {
					mapped.name = 'AbortError';
				}
				cb(mapped);
			},
		);
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
import type { LookupFunction } from 'node:net';
