/**
 * WebSocket forwarding for `proxy` sandbox-exposure mode (Node only).
 *
 * marimo's kernel connection is a WebSocket, which `app.fetch` can't proxy on
 * Node, so we hook the raw server's `upgrade` event. The authorization decision is
 * shared with the HTTP path (`authorizeProxyRequest`); the relay is transparent
 * socket piping. Workers proxy WS natively, so this has no counterpart there.
 */
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import { authorizeProxyRequest, UNSAFE_RESPONSE_HEADERS } from '@marimo-hub/api';
import type { ApiDeps } from '@marimo-hub/api';
import { logEvent } from './log';

type UpgradeServer = { on(event: 'upgrade', listener: UpgradeListener): unknown };
type UpgradeListener = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;

/** Reject an upgrade with a minimal HTTP status line, then close the socket. */
function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
	socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

/** Build a web `Request` from a Node upgrade request so it can be authorized. */
function toWebRequest(req: http.IncomingMessage): Request {
	const host = req.headers.host ?? 'localhost';
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const v of value) headers.append(key, v);
		else headers.set(key, value);
	}
	// Scheme is irrelevant to the authorizer (it reads path + cookies); `http` is fine.
	return new Request(`http://${host}${req.url ?? '/'}`, { method: 'GET', headers });
}

/**
 * Attach the `/proxy/<token>/…` WebSocket forwarder. A no-op unless proxy exposure
 * is configured; non-proxy upgrade paths are left for any other WS handling.
 */
export function attachSandboxProxyUpgrade(server: UpgradeServer, deps: ApiDeps): void {
	if (deps.sandbox.exposure?.mode !== 'proxy') return;

	server.on('upgrade', (req, clientSocket, head) => {
		clientSocket.on('error', () => clientSocket.destroy());

		authorizeProxyRequest(toWebRequest(req), deps)
			.then((decision) => {
				// `pass` means this isn't a kernel route — leave it for any other handler.
				if (decision.kind === 'pass') return;
				if (decision.kind === 'reject') {
					rejectUpgrade(clientSocket, decision.status, decision.code);
					return;
				}

				const target = new URL(decision.targetUrl);
				const lib = target.protocol === 'https:' ? https : http;
				// Rewrite Host + Origin to the kernel so marimo's origin/host check
				// (which would otherwise see the app host) reads the upgrade as
				// same-origin. Hub credentials are stripped (CREDENTIAL_HEADERS in
				// sandboxProxy.ts — notebook code can read request headers); the rest
				// of the WS handshake headers pass through.
				const { cookie: _cookie, authorization: _authorization, ...forwarded } = req.headers;
				const headers = { ...forwarded, host: target.host, origin: target.origin };
				const proxyReq = lib.request({
					protocol: target.protocol,
					hostname: target.hostname,
					port: target.port || (target.protocol === 'https:' ? 443 : 80),
					path: `${target.pathname}${target.search}`,
					method: 'GET',
					headers,
				});

				// Kernel answered without upgrading (e.g. 4xx) — relay the status, close.
				proxyReq.on('response', (proxyRes) => {
					rejectUpgrade(clientSocket, proxyRes.statusCode ?? 502, proxyRes.statusMessage ?? '');
					proxyRes.destroy();
				});

				proxyReq.on('upgrade', (proxyRes, kernelSocket, kernelHead) => {
					const statusLine = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`;
					const headerLines: string[] = [statusLine];
					for (const [key, value] of Object.entries(proxyRes.headers)) {
						if (value === undefined) continue;
						if (UNSAFE_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
						if (Array.isArray(value)) for (const v of value) headerLines.push(`${key}: ${v}`);
						else headerLines.push(`${key}: ${value}`);
					}
					clientSocket.write(`${headerLines.join('\r\n')}\r\n\r\n`);
					if (kernelHead?.length) clientSocket.write(kernelHead);
					if (head?.length) kernelSocket.write(head);

					const teardown = () => {
						kernelSocket.destroy();
						clientSocket.destroy();
					};
					kernelSocket.on('error', teardown);
					kernelSocket.on('close', teardown);
					clientSocket.on('close', teardown);
					kernelSocket.pipe(clientSocket);
					clientSocket.pipe(kernelSocket);
				});

				proxyReq.on('error', (err) => {
					logEvent({
						level: 'warn',
						event: 'sandbox_proxy_ws_upstream_error',
						session_id: decision.sessionId,
						error: err instanceof Error ? err.message : String(err),
					});
					rejectUpgrade(clientSocket, 502, 'Bad Gateway');
				});
				proxyReq.end();
			})
			.catch((err) => {
				logEvent({
					level: 'error',
					event: 'sandbox_proxy_ws_error',
					error: err instanceof Error ? err.message : String(err),
				});
				rejectUpgrade(clientSocket, 500, 'Internal Server Error');
			});
	});
}
