import { Hono } from 'hono';
import type { ApiDeps } from './context';

/**
 * Public OIDC discovery + JWKS for Workload Identity Federation.
 *
 * A federating cloud fetches these unauthenticated, server-side, to validate the
 * hub-issued JWTs it receives — so they mount ahead of the `/api/*` authN guard
 * and return raw JSON, not the `{ success, data }` API envelope. Both routes 404
 * when WIF is unconfigured (`deps.wif` unset).
 */
export function createOidcDiscovery(deps: ApiDeps): Hono {
	const app = new Hono();

	app.get('/.well-known/openid-configuration', (c) => {
		if (!deps.wif) return c.notFound();
		return c.json({
			issuer: deps.wif.issuerUrl,
			jwks_uri: `${deps.wif.issuerUrl}/.well-known/jwks.json`,
			response_types_supported: ['id_token'],
			subject_types_supported: ['public'],
			id_token_signing_alg_values_supported: ['RS256'],
		});
	});

	app.get('/.well-known/jwks.json', async (c) => {
		if (!deps.wif) return c.notFound();
		return c.json(await deps.wif.issuer.jwks());
	});

	return app;
}
