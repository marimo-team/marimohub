import type { SandboxOwner } from '../../ports/sandbox';
import type { Session } from '../../schema';

/**
 * The owner a session record names, for adapters that partition compute per
 * tenant. Passed on every `create` that starts from a record, so an adapter
 * can find the sandbox's partition again after a restart.
 */
export function sessionOwner(session: Pick<Session, 'project_id' | 'user_id'>): SandboxOwner {
	return { projectId: session.project_id, userId: session.user_id };
}
