/**
 * Probe targets are project-manager input, so requests resolve once and pin the
 * socket to the validated addresses. Using `node:http(s)` with a custom lookup
 * prevents DNS rebinding between validation and connection.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import type { RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import type { IntegrationProbe, ProbeRequestInit, ProbeResponse } from '@marimo-hub/core';

export interface GuardedProbeOptions {
	/** Allow private and loopback targets for deployments with on-prem services. */
	allowPrivate?: boolean;
	/** One budget for the whole request: DNS resolution AND the transport. */
	timeoutMs?: number;
	maxResponseBytes?: number;
	/**
	 * Sliding-window cap held by this probe instance. `createFromEnv` builds a
	 * single probe per process, so that is also the process-wide cap; a second
	 * instance (tests, a second config) gets its own independent budget.
	 */
	maxProbesPerMinute?: number;
	/** Injectable request layer; defaults to Node's HTTP(S) transport. */
	transport?: ProbeTransport;
}

/**
 * One policy-checked request: the socket may connect ONLY to `pinned` (the
 * validated addresses, in resolution order), while `url`'s hostname still
 * flows to TLS SNI and `Host`.
 */
export interface ProbeTransportRequest {
	url: URL;
	method: string;
	headers: Record<string, string>;
	body?: string;
	pinned: { address: string; family: number }[];
	timeoutMs: number;
	maxResponseBytes: number;
}

export type ProbeTransport = (
	request: ProbeTransportRequest,
) => Promise<{ status: number; body: string }>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_PROBES_PER_MINUTE = 30;

const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6');

const SPECIAL_GLOBAL_UNICAST_V6 = new BlockList();
SPECIAL_GLOBAL_UNICAST_V6.addSubnet('2001::', 23, 'ipv6');
SPECIAL_GLOBAL_UNICAST_V6.addSubnet('2001:db8::', 32, 'ipv6');
SPECIAL_GLOBAL_UNICAST_V6.addSubnet('2002::', 16, 'ipv6');
SPECIAL_GLOBAL_UNICAST_V6.addSubnet('3fff::', 20, 'ipv6');

export function createGuardedProbe(options: GuardedProbeOptions = {}): IntegrationProbe {
	const {
		allowPrivate = false,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
		maxProbesPerMinute = DEFAULT_MAX_PROBES_PER_MINUTE,
		transport = nodeTransport,
	} = options;
	const recentProbes: number[] = [];

	return {
		async fetch(url: string, init: ProbeRequestInit = {}): Promise<ProbeResponse> {
			const now = Date.now();
			while (recentProbes.length > 0 && now - recentProbes[0] > 60_000) recentProbes.shift();
			if (recentProbes.length >= maxProbesPerMinute) {
				throw new Error('Too many connection tests — try again in a minute.');
			}
			recentProbes.push(now);

			// One deadline for the whole test: a slow resolver eats into the transport's
			// share instead of granting it a fresh timeout (worst case ~2x the limit).
			const deadline = now + timeoutMs;
			const target = parseTarget(url);
			const pinned = await withDeadline(
				resolveAndValidate(target.hostname, allowPrivate),
				deadline,
			);
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) throw timedOut();
			const response = await transport({
				url: target,
				method: init.method ?? 'GET',
				headers: init.headers ?? {},
				body: init.body,
				pinned,
				timeoutMs: remainingMs,
				maxResponseBytes,
			});
			return {
				ok: response.status >= 200 && response.status < 300,
				status: response.status,
				json: () => {
					try {
						return Promise.resolve<unknown>(JSON.parse(response.body));
					} catch {
						return Promise.resolve(undefined);
					}
				},
			};
		},
	};
}

const nodeTransport: ProbeTransport = (probeRequest) =>
	new Promise((resolve, reject) => {
		let settled = false;
		const settle = (fn: () => void) => {
			if (!settled) {
				settled = true;
				fn();
			}
		};
		// The pin: every connect for this request goes to an address that was just
		// validated, regardless of what DNS would say on a second lookup.
		// `autoSelectFamily` (a net.connect option http forwards; missing from
		// @types/node's RequestOptions) keeps Happy-Eyeballs fallback available
		// across the validated set.
		const requestOptions: RequestOptions & { autoSelectFamily?: boolean } = {
			method: probeRequest.method,
			headers: probeRequest.headers,
			lookup: pinnedLookup(probeRequest.pinned),
			autoSelectFamily: true,
			signal: AbortSignal.timeout(probeRequest.timeoutMs),
		};
		const request = (probeRequest.url.protocol === 'https:' ? httpsRequest : httpRequest)(
			probeRequest.url,
			requestOptions,
			(response) => {
				const chunks: Buffer[] = [];
				let total = 0;
				response.on('data', (chunk: Buffer) => {
					total += chunk.length;
					if (total > probeRequest.maxResponseBytes) {
						// Truncated bodies parse as "not JSON"; the status is already known.
						response.destroy();
						settle(() => resolve({ status: response.statusCode ?? 0, body: '' }));
						return;
					}
					chunks.push(chunk);
				});
				response.on('end', () =>
					settle(() =>
						resolve({
							status: response.statusCode ?? 0,
							body: Buffer.concat(chunks).toString('utf8'),
						}),
					),
				);
				response.on('error', (err) => settle(() => reject(err)));
			},
		);
		request.on('error', (err) => settle(() => reject(err)));
		if (probeRequest.body !== undefined) request.write(probeRequest.body);
		request.end();
	});

/** A DNS lookup function that returns only the pre-validated addresses. */
function pinnedLookup(pinned: { address: string; family: number }[]): LookupFunction {
	return ((_hostname: string, lookupOptions: unknown, callback: unknown) => {
		const cb = callback as (err: Error | null, addr: unknown, fam?: number) => void;
		if (typeof lookupOptions === 'object' && (lookupOptions as { all?: boolean } | null)?.all) {
			cb(null, pinned);
		} else {
			cb(null, pinned[0].address, pinned[0].family);
		}
	}) as LookupFunction;
}

function parseTarget(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error('Invalid URL.');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('Only http(s) URLs can be tested.');
	}
	if (parsed.username !== '' || parsed.password !== '') {
		throw new Error('URLs with embedded credentials cannot be tested.');
	}
	return parsed;
}

/** Resolves once and rejects the target if any returned address is forbidden. */
async function resolveAndValidate(
	hostname: string,
	allowPrivate: boolean,
): Promise<{ address: string; family: number }[]> {
	// URL brackets an IPv6 literal; strip them for isIP/lookup.
	const bare = hostname.replaceAll(/^\[|\]$/g, '');
	const literal = isIP(bare);
	if (literal !== 0) {
		if (!allowPrivate && isForbiddenAddress(bare)) throw forbidden(hostname);
		return [{ address: bare, family: literal }];
	}
	let addresses: { address: string; family: number }[];
	try {
		addresses = await lookup(bare, { all: true, verbatim: true });
	} catch {
		throw new Error(`Could not resolve "${hostname}".`);
	}
	if (addresses.length === 0) throw new Error(`Could not resolve "${hostname}".`);
	if (!allowPrivate && addresses.some((a) => isForbiddenAddress(a.address))) {
		throw forbidden(hostname);
	}
	return addresses;
}

/** `dns.lookup` honours no timeout of its own, so bound it from the outside. */
function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		work,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(timedOut()), Math.max(0, deadline - Date.now()));
		}),
	]).finally(() => clearTimeout(timer));
}

function timedOut(): Error {
	return new Error('Connection test timed out.');
}

function forbidden(hostname: string): Error {
	return new Error(
		`"${hostname}" resolves to a private or reserved address, which cannot be tested ` +
			'from this deployment.',
	);
}

function isForbiddenAddress(address: string): boolean {
	if (isIP(address) === 4) return isForbiddenV4(address);
	const lower = address.toLowerCase();
	// IPv4-mapped IPv6 — judge the embedded IPv4. The URL parser normalizes
	// `::ffff:127.0.0.1` to hex groups (`::ffff:7f00:1`), so handle both forms.
	const dotted = /(?:^|:)(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
	if (dotted) return isForbiddenV4(dotted[1]);
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
	if (hex) {
		const hi = Number.parseInt(hex[1], 16);
		const lo = Number.parseInt(hex[2], 16);
		return isForbiddenV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
	}
	return !GLOBAL_UNICAST_V6.check(lower, 'ipv6') || SPECIAL_GLOBAL_UNICAST_V6.check(lower, 'ipv6');
}

function isForbiddenV4(address: string): boolean {
	const octets = address.split('.').map(Number);
	if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return true;
	const [a, b, c] = octets;
	return (
		a === 0 || // "this network"
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
		(a === 169 && b === 254) || // link-local + cloud metadata
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0) || // 192.0.0/24 special-use + 192.0.2/24 TEST-NET
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
		(a === 198 && b === 51 && c === 100) || // TEST-NET-2
		(a === 203 && b === 0 && c === 113) || // TEST-NET-3
		a >= 224 // multicast + reserved + broadcast
	);
}
