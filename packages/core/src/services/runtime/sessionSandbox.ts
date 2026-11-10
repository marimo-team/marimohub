import { NotFoundError } from '../../errors';
import type { ConnectSandboxOptions, SandboxInstance, SandboxProvider } from '../../ports/sandbox';
import type { Session } from '../../schema';
import { sessionOwner } from './sessionOwner';

export function sessionConnectOptions(
	session: Pick<Session, 'project_id' | 'user_id' | 'reconnect_reference'>,
): ConnectSandboxOptions {
	return { owner: sessionOwner(session), reconnectReference: session.reconnect_reference };
}

export function sessionSandbox(provider: SandboxProvider, session: Session): SandboxInstance {
	if (!session.sandbox_id) throw new NotFoundError('Session has no sandbox');
	if (session.reconnect_reference && provider.connectExisting) {
		return provider.connectExisting(session.sandbox_id, sessionConnectOptions(session));
	}
	return provider.create(session.sandbox_id, { owner: sessionOwner(session) });
}
