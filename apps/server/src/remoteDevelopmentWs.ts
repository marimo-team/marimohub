import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { asSandboxPortConnector } from '@marimo-hub/core';
import type { SandboxDuplexConnection } from '@marimo-hub/core';
import { authorizeRemoteDevelopmentRequest, DEVELOPMENT_LEASE_MS } from '@marimo-hub/api';
import type { ApiDeps } from '@marimo-hub/api';
import { WebSocket, WebSocketServer } from 'ws';
import { logEvent } from './log';

const REAUTHORIZE_MS = 30_000;
const MAX_CONNECTIONS_PER_SESSION = 8;

export interface RemoteDevelopmentRelayOptions {
	reauthorizeMs?: number;
	maxConnectionsPerSession?: number;
}

type UpgradeServer = {
	on(
		event: 'upgrade',
		listener: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void,
	): unknown;
};

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
	socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

function toWebRequest(req: http.IncomingMessage): Request {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
		else headers.set(key, value);
	}
	return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
		method: 'GET',
		headers,
	});
}

async function send(ws: WebSocket, chunk: Uint8Array): Promise<void> {
	if (ws.readyState !== WebSocket.OPEN) throw new Error('client websocket closed');
	await new Promise<void>((resolve, reject) => {
		ws.send(chunk, { binary: true }, (error) => (error ? reject(error) : resolve()));
	});
}

async function relay(
	ws: WebSocket,
	connection: SandboxDuplexConnection,
	request: Request,
	deps: ApiDeps,
	sessionId: string,
	projectId: string,
	userId: string,
	backend: string,
	started: number,
	reauthorizeMs: number,
): Promise<void> {
	const writer = connection.writable.getWriter();
	const reader = connection.readable.getReader();
	let clientWrites = Promise.resolve();
	let bytesIn = 0;
	let bytesOut = 0;
	let closed = false;
	const timers: { authorization?: ReturnType<typeof setInterval> } = {};
	let failureCategory = 'none';
	const close = async (code = 1000, reason?: string) => {
		if (closed) return;
		closed = true;
		if (timers.authorization) clearInterval(timers.authorization);
		if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
		await Promise.allSettled([reader.cancel(), writer.close(), connection.close()]);
		try {
			reader.releaseLock();
		} catch {}
		try {
			writer.releaseLock();
		} catch {}
	};
	ws.on('message', (data, isBinary) => {
		if (!isBinary) {
			failureCategory = 'protocol';
			ws.close(1003, 'binary frames required');
			return;
		}
		const raw = Array.isArray(data) ? Buffer.concat(data) : data;
		const chunk = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);
		bytesIn += chunk.byteLength;
		ws.pause();
		clientWrites = clientWrites
			.then(() => writer.write(chunk))
			.catch(() => {
				failureCategory = 'upstream_write';
				return close();
			})
			.finally(() => {
				if (ws.readyState === WebSocket.OPEN) ws.resume();
			});
	});
	ws.on('close', () => void close());
	ws.on('error', () => void close());

	const refresh = async (): Promise<boolean> => {
		let decision: Awaited<ReturnType<typeof authorizeRemoteDevelopmentRequest>>;
		try {
			decision = await authorizeRemoteDevelopmentRequest(request, deps);
		} catch {
			failureCategory = 'authorization_error';
			await close(1011, 'authorization check failed');
			return false;
		}
		if (decision.kind !== 'connect' || decision.session.session_id !== sessionId) {
			failureCategory = 'authorization';
			await close(1008, 'authorization expired');
			return false;
		}
		try {
			await deps.services.sessions.heartbeatDevelopmentConnection(
				decision.session.project_id,
				decision.session.session_id,
				new Date(Date.now() + DEVELOPMENT_LEASE_MS).toISOString(),
			);
		} catch {
			failureCategory = 'lease_refresh';
			await close(1011, 'lease refresh failed');
			return false;
		}
		return true;
	};
	try {
		if (!(await refresh())) return;
		timers.authorization = setInterval(() => void refresh(), reauthorizeMs);
		timers.authorization.unref();

		while (true) {
			if (closed) break;
			const next = await reader.read();
			if (next.done) break;
			bytesOut += next.value.byteLength;
			await send(ws, next.value);
		}
	} catch {
		if (failureCategory === 'none') failureCategory = 'upstream_read';
	} finally {
		await close();
		logEvent({
			level: 'info',
			event: 'sandbox_ssh_disconnected',
			project_id: projectId,
			session_id: sessionId,
			user_id: userId,
			backend,
			duration_ms: Date.now() - started,
			bytes_in: bytesIn,
			bytes_out: bytesOut,
			failure_category: failureCategory,
		});
	}
}

export function attachRemoteDevelopmentUpgrade(
	server: UpgradeServer,
	deps: ApiDeps,
	options: RemoteDevelopmentRelayOptions = {},
): void {
	if (!deps.sandbox.remoteDevelopment) return;
	const connector = asSandboxPortConnector(deps.compute);
	if (!connector) return;
	const reauthorizeMs = options.reauthorizeMs ?? REAUTHORIZE_MS;
	const maxConnectionsPerSession = options.maxConnectionsPerSession ?? MAX_CONNECTIONS_PER_SESSION;
	const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
	const active = new Map<string, number>();

	server.on('upgrade', (req, socket, head) => {
		let request: Request;
		try {
			request = toWebRequest(req);
		} catch {
			rejectUpgrade(socket, 400, 'Bad Request');
			return;
		}
		authorizeRemoteDevelopmentRequest(request, deps)
			.then(async (decision) => {
				if (decision.kind === 'pass') return;
				if (decision.kind === 'reject') {
					rejectUpgrade(socket, decision.status, decision.message);
					return;
				}
				const session = decision.session;
				if (!session.sandbox_id) {
					rejectUpgrade(socket, 409, 'Sandbox unavailable');
					return;
				}
				const count = active.get(session.session_id) ?? 0;
				if (count >= maxConnectionsPerSession) {
					rejectUpgrade(socket, 429, 'Too Many Connections');
					return;
				}
				const release = () => {
					const remaining = (active.get(session.session_id) ?? 1) - 1;
					if (remaining > 0) active.set(session.session_id, remaining);
					else active.delete(session.session_id);
				};
				active.set(session.session_id, count + 1);
				let upstream: SandboxDuplexConnection;
				try {
					upstream = await connector.connectPort(session.sandbox_id, decision.port);
				} catch {
					release();
					throw new Error('upstream connection failed');
				}
				let upgraded = false;
				let abandoned = false;
				const abandon = () => {
					if (upgraded || abandoned) return;
					abandoned = true;
					release();
					void upstream.close().catch(() => {});
				};
				socket.once('close', abandon);
				try {
					webSockets.handleUpgrade(req, socket, head, (ws) => {
						upgraded = true;
						socket.off('close', abandon);
						const started = Date.now();
						const backend =
							deps.sandbox.remoteDevelopment?.backend ?? deps.compute.constructor.name;
						logEvent({
							level: 'info',
							event: 'sandbox_ssh_connected',
							project_id: session.project_id,
							session_id: session.session_id,
							user_id: decision.user.id,
							backend,
							failure_category: 'none',
						});
						void relay(
							ws,
							upstream,
							request,
							deps,
							session.session_id,
							session.project_id,
							decision.user.id,
							backend,
							started,
							reauthorizeMs,
						).finally(() => {
							release();
							deps.metrics?.histogram?.('sandbox.ssh.connection.duration_ms', Date.now() - started);
						});
					});
				} catch (error) {
					abandon();
					throw error;
				}
			})
			.catch(() => {
				logEvent({
					level: 'warn',
					event: 'sandbox_ssh_relay_error',
					failure_category: 'upstream_connect',
				});
				rejectUpgrade(socket, 502, 'Bad Gateway');
			});
	});
}
