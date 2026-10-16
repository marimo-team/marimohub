import { Hono } from 'hono';
import {
	exchangeFederatedStorageCredentials,
	isPastAuthorizationDeadline,
	NotFoundError,
	ProjectId,
	SessionId,
	toContainerCredentialsResponse,
	UserId,
	verifyWifCredentialsToken,
} from '@marimo-hub/core';
import type { Session } from '@marimo-hub/core';
import type { HonoEnv } from '../context';
import { federationFor } from '../federation';
import { errorMetadata, logEvent } from '../log';
import { fail } from '../shared';
import { WifCredentialCache } from '../wifCredentialCache';

export const WIF_CREDENTIALS_PREFIX = '/api/wif/v1';
export const WIF_CREDENTIALS_PATH = `${WIF_CREDENTIALS_PREFIX}/credentials`;

const LIVE_STATUSES: ReadonlySet<Session['status']> = new Set(['starting', 'running']);

export function createWifCredentials(): Hono<HonoEnv> {
	const app = new Hono<HonoEnv>();
	const cache = new WifCredentialCache();

	app.get('/credentials', async (c) => {
		const deps = c.get('deps');
		const wif = deps.wif;
		const endpoint = wif?.credentialsEndpoint;
		if (!wif || !endpoint) {
			return fail(c, 'NOT_FOUND', 'Refreshable WIF credentials are not enabled', 404);
		}

		// AWS SDKs send AWS_CONTAINER_AUTHORIZATION_TOKEN as the raw header value.
		const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
		const claims = token ? await verifyWifCredentialsToken(endpoint.keyMaterial, token) : null;
		if (
			!claims ||
			!ProjectId.is(claims.projectId) ||
			!SessionId.is(claims.sessionId) ||
			!UserId.is(claims.userId)
		) {
			return fail(c, 'UNAUTHORIZED', 'Invalid or expired credentials token', 401);
		}
		const { projectId, sessionId, userId } = claims;
		const denied = () => {
			cache.delete(sessionId);
			return fail(c, 'FORBIDDEN', 'Session is not eligible for federated credentials', 403);
		};

		try {
			const session = await deps.services.sessions.getSession(projectId, sessionId);
			if (
				session.user_id !== userId ||
				!LIVE_STATUSES.has(session.status) ||
				isPastAuthorizationDeadline(session, Date.now()) ||
				session.sandbox_reclaimed_at
			) {
				return denied();
			}
			if (await deps.services.identities.isSuspended(userId)) return denied();
			const project = await deps.services.projects.getProject(projectId);
			if (!federationFor(project, wif)) return denied();

			const creds = await cache.get(sessionId, () =>
				exchangeFederatedStorageCredentials(wif.issuer, wif.issuerUrl, wif.target, projectId, {
					kind: 'session',
					id: sessionId,
				}),
			);
			c.header('Cache-Control', 'no-store');
			return c.json(toContainerCredentialsResponse(creds));
		} catch (err) {
			if (err instanceof NotFoundError) return denied();
			logEvent({
				level: 'warn',
				event: 'wif_credentials_exchange_failed',
				project_id: projectId,
				session_id: sessionId,
				...errorMetadata(err),
			});
			return fail(c, 'SERVICE_UNAVAILABLE', 'Could not obtain federated credentials', 503);
		}
	});

	return app;
}
