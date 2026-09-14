import * as oauth from 'oauth4webapi';

export function oidcIssuerUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('OIDC issuer must be a valid HTTPS URL');
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
		throw new Error('OIDC issuer must be an HTTPS URL without credentials, query, or fragment');
	}
	return url;
}

export function createOidcDiscovery<T>(
	issuer: URL,
	resolve: (metadata: oauth.AuthorizationServer) => T,
): () => Promise<T> {
	let pending: Promise<T> | undefined;
	return () => {
		// Cache successful discovery and concurrent requests, but permit retries after failure.
		pending ??= oauth
			.discoveryRequest(issuer, { algorithm: 'oidc', signal: AbortSignal.timeout(5000) })
			.then((response) => oauth.processDiscoveryResponse(issuer, response))
			.then(resolve)
			.catch((error: unknown) => {
				pending = undefined;
				throw error;
			});
		return pending;
	};
}
