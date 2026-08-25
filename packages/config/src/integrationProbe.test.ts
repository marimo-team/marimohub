import type * as dnsPromises from 'node:dns/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { Server as TcpServer, Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourceExhaustedError, UnavailableError, ValidationError } from '@marimo-hub/core';
import { createGuardedHostResolver, createGuardedProbe } from './integrationProbe';
import type { ProbeConnectionTransportRequest, ProbeTransportRequest } from './integrationProbe';

type PinnedAddress = { address: string; family: number };
type Lookup = (
	hostname: string,
	options: { all: true; verbatim: true },
) => Promise<PinnedAddress[]>;

/** Real resolution, optionally slowed down, so DNS cost is observable in tests. */
const dns = vi.hoisted(() => ({
	delayMs: 0,
	answers: new Map<string, PinnedAddress[]>(),
}));
vi.mock('node:dns/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof dnsPromises>();
	return {
		...actual,
		lookup: async (hostname: string, options: { all: true; verbatim: true }) => {
			if (dns.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, dns.delayMs));
			const answer = dns.answers.get(hostname);
			if (answer) return answer;
			return (actual.lookup as unknown as Lookup)(hostname, options);
		},
	};
});

/** Captures the request after target validation and address pinning. */
function stubTransport(status = 200, body = '{}') {
	const calls: ProbeTransportRequest[] = [];
	const transport = vi.fn((request: ProbeTransportRequest) => {
		calls.push(request);
		return Promise.resolve({ status, body });
	});
	return { transport, calls };
}

function stubConnectionTransport() {
	const calls: ProbeConnectionTransportRequest[] = [];
	const connectionTransport = vi.fn((request: ProbeConnectionTransportRequest) => {
		calls.push(request);
		return Promise.resolve();
	});
	return { connectionTransport, calls };
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	dns.delayMs = 0;
	dns.answers.clear();
});

describe('createGuardedProbe policy', () => {
	it('validates and pins TCP/TLS targets before connecting', async () => {
		const { connectionTransport, calls } = stubConnectionTransport();
		const probe = createGuardedProbe({ connectionTransport });

		await probe.connect({ hostname: '93.184.216.34', port: 15002, tls: true });

		expect(calls[0]).toMatchObject({
			hostname: '93.184.216.34',
			port: 15002,
			tls: true,
			pinned: [{ address: '93.184.216.34', family: 4 }],
		});
		expect(calls[0].timeoutMs).toBeGreaterThan(0);
	});

	it('applies the private-address policy to socket probes', async () => {
		const { connectionTransport } = stubConnectionTransport();
		const probe = createGuardedProbe({ connectionTransport });

		await expect(probe.connect({ hostname: '127.0.0.1', port: 15002, tls: false })).rejects.toThrow(
			/private or reserved/,
		);
		expect(connectionTransport).not.toHaveBeenCalled();
	});

	it('rejects a socket hostname when any DNS answer is private', async () => {
		dns.answers.set('mixed-socket.example.test', [
			{ address: '93.184.216.34', family: 4 },
			{ address: '10.0.0.8', family: 4 },
		]);
		const { connectionTransport } = stubConnectionTransport();
		const probe = createGuardedProbe({ connectionTransport });

		await expect(
			probe.connect({ hostname: 'mixed-socket.example.test', port: 15002, tls: true }),
		).rejects.toThrow(/private or reserved/);
		expect(connectionTransport).not.toHaveBeenCalled();
	});

	it('passes every validated DNS answer and the caller signal to the socket transport', async () => {
		dns.answers.set('spark.example.test', [
			{ address: '93.184.216.34', family: 4 },
			{ address: '2606:4700:4700::1111', family: 6 },
		]);
		const { connectionTransport, calls } = stubConnectionTransport();
		const probe = createGuardedProbe({ connectionTransport });
		const controller = new AbortController();

		await probe.connect({
			hostname: 'spark.example.test',
			port: 15002,
			tls: true,
			signal: controller.signal,
		});

		expect(calls[0].pinned).toEqual([
			{ address: '93.184.216.34', family: 4 },
			{ address: '2606:4700:4700::1111', family: 6 },
		]);
		expect(calls[0].signal).toBe(controller.signal);
	});

	it('normalizes a bracketed IPv6 socket target after validating it', async () => {
		const { connectionTransport, calls } = stubConnectionTransport();
		const probe = createGuardedProbe({ connectionTransport });

		await probe.connect({ hostname: '[2606:4700:4700::1111]', port: 15002, tls: true });

		expect(calls[0]).toMatchObject({
			hostname: '2606:4700:4700::1111',
			pinned: [{ address: '2606:4700:4700::1111', family: 6 }],
		});
	});

	it.each([0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects invalid socket port %s before resolving or connecting',
		async (port) => {
			const { connectionTransport } = stubConnectionTransport();
			const probe = createGuardedProbe({ connectionTransport });

			await expect(probe.connect({ hostname: 'example.com', port, tls: false })).rejects.toThrow(
				/Invalid port/,
			);
			expect(connectionTransport).not.toHaveBeenCalled();
		},
	);

	it('rejects an empty socket hostname before resolving or connecting', async () => {
		const { connectionTransport } = stubConnectionTransport();
		const probe = createGuardedProbe({ connectionTransport });

		await expect(probe.connect({ hostname: '', port: 15002, tls: false })).rejects.toThrow(
			/Invalid hostname/,
		);
		expect(connectionTransport).not.toHaveBeenCalled();
	});

	it('does not hide a socket transport failure', async () => {
		const connectionTransport = vi.fn(() => Promise.reject(new Error('dial failed')));
		const probe = createGuardedProbe({ connectionTransport });

		await expect(
			probe.connect({ hostname: '93.184.216.34', port: 15002, tls: false }),
		).rejects.toThrow('dial failed');
	});

	it('rejects non-http schemes, embedded credentials, and malformed URLs', async () => {
		const probe = createGuardedProbe();
		await expect(probe.fetch('ftp://example.com')).rejects.toBeInstanceOf(ValidationError);
		await expect(probe.fetch('file:///etc/passwd')).rejects.toBeInstanceOf(ValidationError);
		await expect(probe.fetch('https://user:pw@example.com')).rejects.toBeInstanceOf(
			ValidationError,
		);
		await expect(probe.fetch('not a url')).rejects.toBeInstanceOf(ValidationError);
	});

	it('blocks loopback, private, link-local/metadata, CGNAT, and IPv6 special ranges', async () => {
		const { transport } = stubTransport();
		const probe = createGuardedProbe({ transport });
		for (const target of [
			'http://127.0.0.1:8080/x',
			'http://10.1.2.3/',
			'http://172.16.0.1/',
			'http://192.168.1.1/',
			'http://169.254.169.254/latest/meta-data/', // cloud metadata
			'http://100.64.0.1/',
			'http://0.0.0.0/',
			'http://[::1]/',
			'http://[fe80::1]/',
			'http://[fd00::1]/',
			'http://[::ffff:127.0.0.1]/',
			'http://[64:ff9b::a00:1]/',
		]) {
			await expect(probe.fetch(target), target).rejects.toThrow(/private or reserved/);
		}
		expect(transport).not.toHaveBeenCalled();
	});

	it.each(['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://127.1/'])(
		'blocks an alternate numeric encoding of loopback: %s',
		async (target) => {
			const { transport } = stubTransport();
			const probe = createGuardedProbe({ transport });
			await expect(probe.fetch(target)).rejects.toThrow(/private or reserved/);
			expect(transport).not.toHaveBeenCalled();
		},
	);

	it('blocks IPv6 multicast and documentation-only IPv4 ranges', async () => {
		const { transport } = stubTransport();
		const probe = createGuardedProbe({ transport });
		for (const target of ['http://[ff02::1]/', 'http://198.51.100.1/', 'http://203.0.113.1/']) {
			await expect(probe.fetch(target), target).rejects.toThrow(/private or reserved/);
		}
		expect(transport).not.toHaveBeenCalled();
	});

	it.each([
		'http://[2001:db8::1]/',
		'http://[3fff::1]/',
		'http://[fec0::1]/',
		'http://[2001::1]/',
		'http://[2002:7f00:1::]/',
		'http://[100::1]/',
		'http://[5f00::1]/',
	])(
		'blocks non-global IPv6 documentation, site-local, and transition address %s',
		async (target) => {
			const { transport } = stubTransport();
			const probe = createGuardedProbe({ transport });
			await expect(probe.fetch(target)).rejects.toThrow(/private or reserved/);
			expect(transport).not.toHaveBeenCalled();
		},
	);

	it('allows an ordinary global-unicast IPv6 literal', async () => {
		const { transport, calls } = stubTransport();
		const probe = createGuardedProbe({ transport });
		await expect(probe.fetch('https://[2606:4700:4700::1111]/')).resolves.toMatchObject({
			ok: true,
		});
		expect(calls[0].pinned).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]);
	});

	it('rejects a hostname when any DNS answer is private', async () => {
		dns.answers.set('mixed.example.test', [
			{ address: '93.184.216.34', family: 4 },
			{ address: '10.0.0.8', family: 4 },
		]);
		const { transport } = stubTransport();
		const probe = createGuardedProbe({ transport });

		await expect(probe.fetch('https://mixed.example.test/')).rejects.toThrow(/private or reserved/);
		expect(transport).not.toHaveBeenCalled();
	});

	it('blocks hostnames that RESOLVE to a forbidden address (e.g. localhost)', async () => {
		const { transport } = stubTransport();
		const probe = createGuardedProbe({ transport });
		await expect(probe.fetch('http://localhost:2718/')).rejects.toThrow(/private or reserved/);
		expect(transport).not.toHaveBeenCalled();
	});

	it('explains how to allow a trusted private-network target', async () => {
		const { transport } = stubTransport();
		const probe = createGuardedProbe({ transport });

		await expect(probe.fetch('http://10.0.0.5/')).rejects.toMatchObject({
			name: 'UnavailableError',
			message: expect.stringContaining('MARIMOHUB_INTEGRATIONS_PROBE=private'),
		});
	});

	it('PINS the socket to the validated addresses (DNS cannot rebind mid-request)', async () => {
		const { transport, calls } = stubTransport();
		const probe = createGuardedProbe({ transport });
		await probe.fetch('https://93.184.216.34/health'); // public literal bypasses DNS
		expect(calls[0].pinned).toEqual([{ address: '93.184.216.34', family: 4 }]);

		const resolved = createGuardedProbe({ transport, allowPrivate: true });
		await resolved.fetch('http://localhost:9/');
		// The transport must receive the addresses validation saw — never re-resolve.
		expect(calls[1].pinned.length).toBeGreaterThan(0);
		for (const { address } of calls[1].pinned) {
			expect(['127.0.0.1', '::1']).toContain(address);
		}
		expect(calls[1].url.hostname).toBe('localhost');
	});

	it('passes method/headers/body through to the request layer', async () => {
		const { transport, calls } = stubTransport(302, '');
		const probe = createGuardedProbe({ transport, allowPrivate: true });
		const res = await probe.fetch('http://10.0.0.5/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'grant_type=client_credentials',
		});
		expect(res.ok).toBe(false);
		expect(res.status).toBe(302);
		expect(calls[0]).toMatchObject({
			method: 'POST',
			body: 'grant_type=client_credentials',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		});
	});

	it('forwards the caller signal to the pinned transport', async () => {
		const { transport, calls } = stubTransport();
		const probe = createGuardedProbe({ transport });
		const controller = new AbortController();
		await probe.fetch('https://93.184.216.34/health', { signal: controller.signal });
		expect(calls[0].signal).toBe(controller.signal);
	});

	it('rate-limits probes per probe instance', async () => {
		const { transport } = stubTransport();
		const probe = createGuardedProbe({ transport, allowPrivate: true, maxProbesPerMinute: 2 });
		await probe.fetch('http://10.0.0.5/');
		await probe.fetch('http://10.0.0.5/');
		await expect(probe.fetch('http://10.0.0.5/')).rejects.toBeInstanceOf(ResourceExhaustedError);

		// The budget belongs to the instance, not the module: `createFromEnv` builds
		// exactly one probe per process, which is what makes it the process cap.
		const second = createGuardedProbe({ transport, allowPrivate: true, maxProbesPerMinute: 2 });
		await expect(second.fetch('http://10.0.0.5/')).resolves.toMatchObject({ ok: true });
	});

	it('shares one rate-limit budget between HTTP and socket probes', async () => {
		const { transport } = stubTransport();
		const { connectionTransport } = stubConnectionTransport();
		const probe = createGuardedProbe({
			transport,
			connectionTransport,
			allowPrivate: true,
			maxProbesPerMinute: 1,
		});

		await probe.fetch('http://10.0.0.5/');
		await expect(probe.connect({ hostname: '10.0.0.5', port: 15002, tls: false })).rejects.toThrow(
			/Too many/,
		);
		expect(connectionTransport).not.toHaveBeenCalled();
	});

	it('spends ONE deadline across resolution and transport', async () => {
		dns.delayMs = 60;
		const { transport, calls } = stubTransport();
		const probe = createGuardedProbe({ transport, allowPrivate: true, timeoutMs: 200 });
		await probe.fetch('http://localhost:9/');
		// ~60ms of the 200ms budget went to resolution, so the transport gets ~140ms.
		// Node's setTimeout can fire a millisecond early, so allow slack above 140
		// rather than pinning the exact boundary (the point is that DNS ate the budget).
		expect(calls[0].timeoutMs).toBeLessThanOrEqual(150);
		expect(calls[0].timeoutMs).toBeGreaterThan(0);
	});

	it('fails without connecting when resolution alone exhausts the deadline', async () => {
		dns.delayMs = 200;
		const { transport } = stubTransport();
		const probe = createGuardedProbe({ transport, allowPrivate: true, timeoutMs: 30 });
		await expect(probe.fetch('http://localhost:9/')).rejects.toMatchObject({
			name: 'UnavailableError',
			message: 'The integration request timed out.',
		});
		expect(transport).not.toHaveBeenCalled();
	});

	it('subtracts socket DNS time from the connection transport deadline', async () => {
		dns.delayMs = 60;
		const { connectionTransport, calls } = stubConnectionTransport();
		const probe = createGuardedProbe({
			connectionTransport,
			allowPrivate: true,
			timeoutMs: 200,
		});

		await probe.connect({ hostname: 'localhost', port: 15002, tls: false });

		expect(calls[0].timeoutMs).toBeLessThanOrEqual(150);
		expect(calls[0].timeoutMs).toBeGreaterThan(0);
	});

	it('does not open a socket when DNS exhausts the connection deadline', async () => {
		dns.delayMs = 200;
		const { connectionTransport } = stubConnectionTransport();
		const probe = createGuardedProbe({
			connectionTransport,
			allowPrivate: true,
			timeoutMs: 30,
		});

		await expect(probe.connect({ hostname: 'localhost', port: 15002, tls: false })).rejects.toThrow(
			/timed out/,
		);
		expect(connectionTransport).not.toHaveBeenCalled();
	});

	it('stops socket DNS resolution when the caller aborts', async () => {
		dns.delayMs = 200;
		const { connectionTransport } = stubConnectionTransport();
		const probe = createGuardedProbe({
			connectionTransport,
			allowPrivate: true,
			timeoutMs: 1_000,
		});
		const controller = new AbortController();
		const pending = probe.connect({
			hostname: 'localhost',
			port: 15002,
			tls: false,
			signal: controller.signal,
		});

		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(connectionTransport).not.toHaveBeenCalled();
	});

	it('restores probe budget after the sliding window expires', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
		const { transport } = stubTransport();
		const probe = createGuardedProbe({ transport, allowPrivate: true, maxProbesPerMinute: 1 });
		await probe.fetch('http://10.0.0.5/');
		await expect(probe.fetch('http://10.0.0.5/')).rejects.toBeInstanceOf(ResourceExhaustedError);

		vi.advanceTimersByTime(60_001);
		await expect(probe.fetch('http://10.0.0.5/')).resolves.toMatchObject({ ok: true });
	});

	it('classifies and sanitizes transport failures before logging', async () => {
		const transport = vi.fn(() =>
			Promise.reject(
				Object.assign(new Error('connect ECONNREFUSED https://user:secret@example.test'), {
					code: 'ECONNREFUSED',
				}),
			),
		);
		const probe = createGuardedProbe({ transport });

		const error = await probe.fetch('https://93.184.216.34/').catch((err: unknown) => err);

		expect(error).toBeInstanceOf(UnavailableError);
		expect(error).toMatchObject({
			message: 'The integration target refused the connection.',
			cause: {
				name: 'IntegrationTransportError',
				message: 'Integration transport failure',
				code: 'ECONNREFUSED',
			},
		});
		const typedError = error as Error;
		const cause = typedError.cause as Error;
		const diagnostic = [typedError.message, typedError.stack, cause.message, cause.stack].join(
			'\n',
		);
		expect(diagnostic).not.toContain('secret');
		expect(diagnostic).not.toContain('user:');
	});
});

describe('createGuardedProbe node socket transport', () => {
	let server: TcpServer | undefined;
	const sockets = new Set<Socket>();

	afterEach(async () => {
		for (const socket of sockets) socket.destroy();
		sockets.clear();
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
	});

	function tcpServer(onConnection?: () => void): TcpServer {
		return createTcpServer((socket) => {
			sockets.add(socket);
			socket.once('close', () => sockets.delete(socket));
			onConnection?.();
		});
	}

	it('connects to a validated, pinned TCP endpoint', async () => {
		server = tcpServer();
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('no port');
		const probe = createGuardedProbe({ allowPrivate: true });

		await expect(
			probe.connect({ hostname: 'localhost', port: address.port, tls: false }),
		).resolves.toBeUndefined();
	});

	it('times out when a TLS endpoint never completes its handshake', async () => {
		server = tcpServer();
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('no port');
		const probe = createGuardedProbe({ allowPrivate: true, timeoutMs: 25 });

		await expect(
			probe.connect({ hostname: 'localhost', port: address.port, tls: true }),
		).rejects.toThrow(/timed out/);
	});

	it('aborts an in-progress TLS handshake when the caller cancels', async () => {
		let connected!: () => void;
		const accepted = new Promise<void>((resolve) => {
			connected = resolve;
		});
		server = tcpServer(connected);
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('no port');
		const probe = createGuardedProbe({ allowPrivate: true, timeoutMs: 1_000 });
		const controller = new AbortController();
		const pending = probe.connect({
			hostname: 'localhost',
			port: address.port,
			tls: true,
			signal: controller.signal,
		});
		await accepted;

		controller.abort();

		await expect(pending).rejects.toMatchObject({
			name: 'AbortError',
			message: 'Connection test aborted.',
		});
	});

	it('rejects when the peer closes before the TLS handshake', async () => {
		server = createTcpServer((socket) => socket.destroy());
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('no port');
		const probe = createGuardedProbe({ allowPrivate: true });

		await expect(
			probe.connect({ hostname: 'localhost', port: address.port, tls: true }),
		).rejects.toThrow();
	});
});

describe('createGuardedHostResolver', () => {
	it('stops waiting for DNS when the operation signal aborts', async () => {
		dns.delayMs = 200;
		const controller = new AbortController();
		const pending = createGuardedHostResolver({ allowPrivate: true, timeoutMs: 1_000 })(
			'localhost',
			controller.signal,
		);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});
});

describe('createGuardedProbe node transport (real local server)', () => {
	let server: Server | undefined;

	afterEach(async () => {
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
	});

	async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
		server = createServer(handler);
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		if (address === null || typeof address === 'string') throw new Error('no port');
		// `localhost` (not the IP) so the request exercises resolve → validate → pin.
		return `http://localhost:${address.port}`;
	}

	it('round-trips JSON through the pinned connection', async () => {
		const base = await serve((req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
		});
		const probe = createGuardedProbe({ allowPrivate: true });
		const res = await probe.fetch(`${base}/v1/info`);
		expect(res.ok).toBe(true);
		// Host header carries the hostname even though the socket was pinned by IP.
		expect(await res.json()).toMatchObject({
			path: '/v1/info',
			host: expect.stringContaining('localhost'),
		});
	});

	it('does not follow redirects', async () => {
		let hits = 0;
		const base = await serve((_req, res) => {
			hits += 1;
			res.statusCode = 302;
			res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
			res.end();
		});
		const probe = createGuardedProbe({ allowPrivate: true });
		const res = await probe.fetch(base);
		expect(res.status).toBe(302);
		expect(res.ok).toBe(false);
		expect(hits).toBe(1);
	});

	it('caps the response size (an oversized body parses as non-JSON)', async () => {
		const base = await serve((_req, res) => {
			res.end('x'.repeat(4096));
		});
		const probe = createGuardedProbe({ allowPrivate: true, maxResponseBytes: 1024 });
		const res = await probe.fetch(base);
		expect(res.ok).toBe(true);
		expect(await res.json()).toBeUndefined();
	});

	it('aborts a response that does not complete before the timeout', async () => {
		const base = await serve((_req, res) => {
			res.writeHead(200);
			res.write('partial');
		});
		const probe = createGuardedProbe({ allowPrivate: true, timeoutMs: 25 });
		await expect(probe.fetch(base)).rejects.toThrow();
	});
});
