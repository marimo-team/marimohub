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
			const bearer = bearerToken(request);
			if (bearer !== null && isPersonalAccessToken(bearer)) {
				return tokens.verify(bearer);
			}
			if (external && /^bearer(?:\s|$)/i.test(request.headers.get('authorization') ?? '')) {
				return external.authenticate(request);
			}
			return sso.authenticate(request);
		},
		...(logoutUrl ? { logoutUrl } : {}),
	};
}
