import type { Authenticator } from '../../ports/auth';
import { bearerToken, isPersonalAccessToken } from './TokenService';
import type { TokenService } from './TokenService';

/** Configured bearer authenticators own failures; a cookie must not override them. */
export function composeAuthenticators(
	tokens: TokenService,
	sso: Authenticator,
	external?: Authenticator,
): Authenticator {
	const logoutUrl = sso.logoutUrl?.bind(sso);
	return {
		async authenticate(request) {
			const authorization = request.headers.get('authorization') ?? '';
			const hasBearer = /(?:^|,)\s*bearer(?:\s|,|$)/i.test(authorization);
			// Fetch combines duplicate Authorization fields; never choose among credentials.
			if (hasBearer && authorization.includes(',')) return null;
			const bearer = bearerToken(request);
			if (bearer !== null && isPersonalAccessToken(bearer)) {
				return tokens.verify(bearer);
			}
			if (external && hasBearer) {
				return external.authenticate(request);
			}
			return sso.authenticate(request);
		},
		...(logoutUrl ? { logoutUrl } : {}),
	};
}
