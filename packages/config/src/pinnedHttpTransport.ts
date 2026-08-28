import { request as httpRequest } from 'node:http';
import type { RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createPinnedLookup } from '@marimo-hub/object-browser-commons';
import type { PinnedAddress } from '@marimo-hub/object-browser-commons';

export interface PinnedHttpTransportRequest {
	url: URL;
	method: string;
	headers?: Readonly<Record<string, string>>;
	body?: string;
	pinned: readonly PinnedAddress[];
	maxResponseBytes: number;
	signal?: AbortSignal;
	overflow: 'empty' | 'reject';
	overflowError?: () => Error;
	checkContentLength?: boolean;
}

export interface PinnedHttpTransportResponse {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
}

export function pinnedHttpRequest(
	request: PinnedHttpTransportRequest,
): Promise<PinnedHttpTransportResponse> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};
		const requestOptions: RequestOptions & { autoSelectFamily?: boolean } = {
			method: request.method,
			headers: request.headers,
			lookup: createPinnedLookup([...request.pinned]),
			autoSelectFamily: true,
			agent: false,
			signal: request.signal,
		};
		const outgoing = (request.url.protocol === 'https:' ? httpsRequest : httpRequest)(
			request.url,
			requestOptions,
			(response) => {
				const headers = Object.fromEntries(
					Object.entries(response.headers).flatMap(([name, value]) =>
						value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
					),
				);
				const overflow = () => {
					response.destroy();
					if (request.overflow === 'empty') {
						settle(() =>
							resolve({ status: response.statusCode ?? 0, headers, body: new Uint8Array() }),
						);
					} else {
						settle(() =>
							reject(request.overflowError?.() ?? new Error('HTTP response is too large.')),
						);
					}
				};
				const declared = Number(response.headers['content-length']);
				if (
					request.checkContentLength &&
					Number.isFinite(declared) &&
					declared > request.maxResponseBytes
				) {
					overflow();
					return;
				}
				const chunks: Buffer[] = [];
				let total = 0;
				response.on('data', (chunk: Buffer) => {
					total += chunk.byteLength;
					if (total > request.maxResponseBytes) {
						overflow();
						return;
					}
					chunks.push(chunk);
				});
				response.on('end', () =>
					settle(() =>
						resolve({
							status: response.statusCode ?? 0,
							headers,
							body: new Uint8Array(Buffer.concat(chunks)),
						}),
					),
				);
				response.on('error', (error) => settle(() => reject(error)));
			},
		);
		outgoing.on('error', (error) => settle(() => reject(error)));
		if (request.body !== undefined) outgoing.write(request.body);
		outgoing.end();
	});
}
