import { NotFoundError } from '../../errors';
import type { ConnectSandboxOptions, SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import type { Session } from '../../schema';
import { sessionOwner } from './sessionOwner';
import type { Metrics } from '../../ports/metrics';

export function recordSessionReconnect(
	session: Session,
	metrics: Metrics | undefined,
	path: string,
): void {
	try {
		metrics?.increment('sandbox.reconnect', 1, {
			path,
			method: session.reconnect_reference ? 'reference' : 'lookup',
		});
	} catch {}
}

export function sessionConnectOptions(
	session: Pick<Session, 'project_id' | 'user_id' | 'reconnect_reference'>,
): ConnectSandboxOptions {
	return { owner: sessionOwner(session), reconnectReference: session.reconnect_reference };
}

export function sessionSandbox(
	provider: SandboxProvider,
	session: Session,
	metrics?: Metrics,
	path = 'other',
): SandboxInstance {
	if (!session.sandbox_id) throw new NotFoundError('Session has no sandbox');
	if (session.reconnect_reference && provider.connectExisting) {
		recordSessionReconnect(session, metrics, path);
		return provider.connectExisting(session.sandbox_id, sessionConnectOptions(session));
	}
	recordSessionReconnect({ ...session, reconnect_reference: undefined }, metrics, path);
	return provider.create(session.sandbox_id, { owner: sessionOwner(session) });
}

/**
 * Attach to the session's existing sandbox without the create fallback, which can launch a
 * replacement when the original is gone. Undefined when the provider cannot attach.
 */
export function reconnectSessionSandbox(
	provider: SandboxProvider,
	session: Session,
	metrics?: Metrics,
	path = 'other',
): SandboxInstance | undefined {
	if (!provider.connectExisting) return undefined;
	if (!session.sandbox_id) throw new NotFoundError('Session has no sandbox');
	recordSessionReconnect(session, metrics, path);
	return provider.connectExisting(session.sandbox_id, sessionConnectOptions(session));
}
