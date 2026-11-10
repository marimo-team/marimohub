import type { SandboxOwner } from '../../ports/sandbox';
import type { Session } from '../../schema';

/** Adapters use this owner to find the tenant's sandbox partition after a restart. */
export function sessionOwner(session: Pick<Session, 'project_id' | 'user_id'>): SandboxOwner {
	return { projectId: session.project_id, userId: session.user_id };
}
