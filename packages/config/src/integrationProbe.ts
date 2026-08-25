/**
 * Probe targets are project-manager input, so requests resolve once and pin the
 * socket to the validated addresses. Using `node:http(s)` with a custom lookup
 * prevents DNS rebinding between validation and connection.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import type { RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, connect as netConnect, isIP } from 'node:net';
import type { TcpSocketConnectOpts } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import {
	createSlidingWindowBudget,
	DomainError,
	parseHttpUrl,
	ResourceExhaustedError,
	UnavailableError,
	ValidationError,
	withDeadline,
} from '@marimo-hub/core';
import type {
	IntegrationProbe,
	ProbeConnectRequest,
	ProbeRequestInit,
	ProbeResponse,
} from '@marimo-hub/core';
import { createPinnedLookup } from '@marimo-hub/object-browser-commons';
import type { GuardedHostResolver, PinnedAddress } from '@marimo-hub/object-browser-commons';

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
	/** Injectable socket layer; defaults to Node's TCP/TLS transport. */
	connectionTransport?: ProbeConnectionTransport;
}

export type { GuardedHostResolver, PinnedAddress } from '@marimo-hub/object-browser-commons';

export function createGuardedHostResolver(
	options: {
		allowPrivate?: boolean;
		timeoutMs?: number;
	} = {},
): GuardedHostResolver {
	const { allowPrivate = false, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
	return (hostname, signal) =>
		withDeadline(resolveAndValidate(hostname, allowPrivate), {
			timeoutMs,
			timeoutError: timedOut,
			signal,
			abortError: aborted,
		});
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
	pinned: PinnedAddress[];
	timeoutMs: number;
	maxResponseBytes: number;
	signal?: AbortSignal;
}

export type ProbeTransport = (
	request: ProbeTransportRequest,
) => Promise<{ status: number; body: string; headers?: Readonly<Record<string, string>> }>;

export interface ProbeConnectionTransportRequest extends ProbeConnectRequest {
	pinned: PinnedAddress[];
	timeoutMs: number;
}

export type ProbeConnectionTransport = (request: ProbeConnectionTransportRequest) => Promise<void>;

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
		connectionTransport = nodeConnectionTransport,
	} = options;
	const probeBudget = createSlidingWindowBudget<'probe'>({
		limit: maxProbesPerMinute,
		windowMs: 60_000,
	});

	return {
		async connect(request: ProbeConnectRequest): Promise<void> {
			const now = Date.now();
			consumeProbeBudget(probeBudget);
			if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65_535) {
				throw new Error('Invalid port.');
			}
			const hostname = request.hostname.replaceAll(/^\[|\]$/g, '');
			if (hostname === '') throw new Error('Invalid hostname.');
			const deadline = now + timeoutMs;
			const pinned = await withDeadline(resolveAndValidate(hostname, allowPrivate), {
				timeoutMs: Math.max(0, deadline - Date.now()),
				timeoutError: timedOut,
				signal: request.signal,
				abortError: aborted,
			});
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) throw timedOut();
			await connectionTransport({
				...request,
				hostname,
				pinned,
				timeoutMs: remainingMs,
			});
		},
		async fetch(url: string, init: ProbeRequestInit = {}): Promise<ProbeResponse> {
			const now = Date.now();
			consumeProbeBudget(probeBudget);

			// One deadline for the whole test: a slow resolver eats into the transport's
			// share instead of granting it a fresh timeout (worst case ~2x the limit).
			const deadline = now + timeoutMs;
			const target = parseTarget(url);
			const pinned = await withDeadline(resolveAndValidate(target.hostname, allowPrivate), {
				timeoutMs: Math.max(0, deadline - Date.now()),
				timeoutError: timedOut,
				signal: init.signal,
				abortError: aborted,
			});
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) throw timedOut();
			let response: Awaited<ReturnType<ProbeTransport>>;
			try {
				response = await transport({
					url: target,
					method: init.method ?? 'GET',
					headers: init.headers ?? {},
					body: init.body,
					pinned,
					timeoutMs: remainingMs,
					maxResponseBytes,
					signal: init.signal,
				});
			} catch (err) {
				if (init.signal?.aborted) throw aborted();
				if (err instanceof DomainError) throw err;
				throw transportFailure(err);
			}
			return {
				ok: response.status >= 200 && response.status < 300,
				status: response.status,
				headers: response.headers,
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

function consumeProbeBudget(budget: ReturnType<typeof createSlidingWindowBudget<'probe'>>): void {
	if (!budget.consume('probe')) {
		throw new ResourceExhaustedError('Too many integration requests — try again in a minute.');
	}
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
			lookup: createPinnedLookup(probeRequest.pinned),
			autoSelectFamily: true,
			signal: probeRequest.signal
				? AbortSignal.any([probeRequest.signal, AbortSignal.timeout(probeRequest.timeoutMs)])
				: AbortSignal.timeout(probeRequest.timeoutMs),
		};
		const request = (probeRequest.url.protocol === 'https:' ? httpsRequest : httpRequest)(
			probeRequest.url,
			requestOptions,
			(response) => {
				const headers = Object.fromEntries(
					Object.entries(response.headers).flatMap(([name, value]) =>
						value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]],
					),
				);
				const chunks: Buffer[] = [];
				let total = 0;
				response.on('data', (chunk: Buffer) => {
					total += chunk.length;
					if (total > probeRequest.maxResponseBytes) {
						// Truncated bodies parse as "not JSON"; the status is already known.
						response.destroy();
						settle(() => resolve({ status: response.statusCode ?? 0, body: '', headers }));
						return;
					}
					chunks.push(chunk);
				});
				response.on('end', () =>
					settle(() =>
						resolve({
							status: response.statusCode ?? 0,
							body: Buffer.concat(chunks).toString('utf8'),
							headers,
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

const nodeConnectionTransport: ProbeConnectionTransport = (request) =>
	new Promise((resolve, reject) => {
		let settled = false;
		const signal = request.signal
			? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
			: AbortSignal.timeout(request.timeoutMs);
		const options: TcpSocketConnectOpts & { autoSelectFamily?: boolean } = {
			host: request.hostname,
			port: request.port,
			lookup: createPinnedLookup(request.pinned),
			autoSelectFamily: true,
		};
		const socket = request.tls
			? tlsConnect({
					...options,
					...(isIP(request.hostname) === 0 ? { servername: request.hostname } : {}),
					rejectUnauthorized: true,
				})
			: netConnect(options);
		const successEvent = request.tls ? 'secureConnect' : 'connect';
		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			socket.destroy();
			if (error) reject(error);
			else resolve();
		};
		const onAbort = () => settle(request.signal?.aborted ? aborted() : timedOut());
		socket.once(successEvent, () => settle());
		socket.once('error', settle);
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) onAbort();
	});

function parseTarget(url: string): URL {
	const parsed = parseHttpUrl(url);
	if (parsed.ok) return parsed.url;
	if (parsed.issue === 'protocol') {
		throw new ValidationError('Integration request URLs must use http(s).');
	}
	if (parsed.issue === 'credentials') {
		throw new ValidationError('Integration request URLs cannot contain embedded credentials.');
	}
	throw new ValidationError('Invalid integration request URL.');
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
	} catch (err) {
		throw new UnavailableError('The integration target could not be resolved.', {
			cause: safeTransportCause(err),
		});
	}
	if (addresses.length === 0) {
		throw new UnavailableError('The integration target could not be resolved.');
	}
	if (!allowPrivate && addresses.some((a) => isForbiddenAddress(a.address))) {
		throw forbidden(hostname);
	}
	return addresses;
}

function timedOut(): Error {
	return new UnavailableError('The integration request timed out.');
}

function aborted(): Error {
	return Object.assign(new Error('Connection test aborted.'), { name: 'AbortError' });
}

function forbidden(_hostname: string): Error {
	return new UnavailableError(
		'The integration target resolves to a private or reserved address. Set ' +
			'MARIMOHUB_INTEGRATIONS_PROBE=private for trusted private-network services.',
	);
}

function safeTransportCode(err: unknown, depth = 3): string | undefined {
	if (!(err instanceof Error) || depth < 0) return undefined;
	const code = (err as Error & { code?: unknown }).code;
	if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
	const cause = (err as Error & { cause?: unknown }).cause;
	return cause === undefined ? undefined : safeTransportCode(cause, depth - 1);
}

function safeTransportCause(err: unknown): Error {
	const cause = new Error('Integration transport failure');
	cause.name = 'IntegrationTransportError';
	const code = safeTransportCode(err);
	return code ? Object.assign(cause, { code }) : cause;
}

function transportFailure(err: unknown): UnavailableError {
	const code = safeTransportCode(err);
	const message =
		code === 'ECONNREFUSED'
			? 'The integration target refused the connection.'
			: code === 'ECONNRESET'
				? 'The integration target reset the connection.'
				: code === 'ETIMEDOUT' || code === 'ABORT_ERR' || code === 'UND_ERR_CONNECT_TIMEOUT'
					? 'The integration request timed out.'
					: code && /(?:CERT|TLS|SSL|SELF_SIGNED|VERIFY)/.test(code)
						? "The integration target's TLS certificate could not be verified."
						: 'The integration request could not connect to its target.';
	return new UnavailableError(message, { cause: safeTransportCause(err) });
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
