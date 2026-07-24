import type { Authenticator } from '../../ports/auth';
import { bearerToken, isPersonalAccessToken } from './TokenService';
import type { TokenService } from './TokenService';

/**
 * Wrap an SSO `Authenticator` with personal-access-token support. A request
 * carrying `Authorization: Bearer mhub_pat_…` is resolved by the TokenService
 * ALONE — a malformed or invalid PAT yields null (401), never a fall-through to
 * SSO, so a leaked-but-revoked token can't silently downgrade to cookie auth.
 * Everything else (cookies, no credential) delegates to the SSO adapter
 * unchanged. The `Authenticator` port itself is untouched.
 */
export function composeAuthenticators(tokens: TokenService, sso: Authenticator): Authenticator {
	const logoutUrl = sso.logoutUrl?.bind(sso);
	return {
		async authenticate(request) {
			const bearer = bearerToken(request);
			if (bearer !== null && isPersonalAccessToken(bearer)) {
				return tokens.verify(bearer);
			}
			return sso.authenticate(request);
		},
		...(logoutUrl ? { logoutUrl } : {}),
	};
}
