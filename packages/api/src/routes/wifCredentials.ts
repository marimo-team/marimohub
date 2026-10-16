import { Hono } from 'hono';
import {
	exchangeFederatedStorageCredentials,
	NotFoundError,
	ProjectId,
	SessionId,
	toContainerCredentialsResponse,
	UserId,
	verifyWifCredentialsToken,
} from '@marimo-hub/core';
import type { Session, TempS3Creds } from '@marimo-hub/core';
import type { HonoEnv } from '../context';
import { federationFor } from '../federation';
import { errorMetadata, logEvent } from '../log';
import { fail } from '../shared';

export const WIF_CREDENTIALS_PREFIX = '/api/wif/v1';
export const WIF_CREDENTIALS_PATH = `${WIF_CREDENTIALS_PREFIX}/credentials`;

const REFRESH_MARGIN_MS = 20 * 60_000;
const UNDATED_CACHE_MS = 5 * 60_000;
const UNDATED_LIFETIME_MS = 15 * 60_000;

const LIVE_STATUSES: ReadonlySet<Session['status']> = new Set(['starting', 'running']);

type DatedCreds = TempS3Creds & { expiration: string };

interface CacheEntry {
	creds: Promise<DatedCreds>;
	reuseUntil: number;
}

export function createWifCredentials(): Hono<HonoEnv> {
	const app = new Hono<HonoEnv>();
	const cache = new Map<string, CacheEntry>();

	const exchange = (key: string, run: () => Promise<TempS3Creds>): Promise<DatedCreds> => {
		const now = Date.now();
		const hit = cache.get(key);
		if (hit && hit.reuseUntil > now) return hit.creds;
		for (const [k, stale] of cache) if (stale.reuseUntil <= now) cache.delete(k);
		const entry: CacheEntry = {
			reuseUntil: now + UNDATED_CACHE_MS,
			creds: run().then((creds) => {
				const expiry = creds.expiration ? Date.parse(creds.expiration) : Number.NaN;
				if (creds.expiration && Number.isFinite(expiry)) {
					entry.reuseUntil = expiry - REFRESH_MARGIN_MS;
					return { ...creds, expiration: creds.expiration };
				}
				// Undated creds get a short synthetic expiry so SDKs keep coming back for fresh ones.
				return { ...creds, expiration: new Date(now + UNDATED_LIFETIME_MS).toISOString() };
			}),
		};
		entry.creds.catch(() => cache.delete(key));
		cache.set(key, entry);
		return entry.creds;
	};

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
				session.sandbox_reclaimed_at
			) {
				return denied();
			}
			if (await deps.services.identities.isSuspended(userId)) return denied();
			const project = await deps.services.projects.getProject(projectId);
			if (!federationFor(project, wif)) return denied();

			const creds = await exchange(sessionId, () =>
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
