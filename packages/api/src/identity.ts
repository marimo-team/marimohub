import type { Context } from 'hono';
import type { AuthUser } from '@marimo-hub/core';
import type { ApiDeps, HonoEnv } from './context';
import { errorMetadata, logEvent } from './log';

/** Directory refresh failures must not block an otherwise authenticated request. */
export async function refreshIdentity(
	c: Context<HonoEnv>,
	deps: ApiDeps,
	user: AuthUser,
): Promise<void> {
	try {
		await deps.services.identities.upsert(user);
	} catch (err) {
		logEvent({
			level: 'error',
			event: 'identity_upsert_failed',
			request_id: c.get('requestId') ?? null,
			method: c.req.method,
			path: c.req.path,
			user: user.id,
			error: errorMetadata(err),
		});
	}
}
