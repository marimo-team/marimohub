import { parseBearerAuthorization } from '../../bearerToken';
import type { AuthenticatedPrincipal, Authenticator } from '../../ports/auth';
import { isPersonalAccessToken } from './TokenService';
import type { TokenService } from './TokenService';
import { SERVICE_ACCOUNT_PREFIX, SERVICE_ACCOUNT_USER_PREFIX } from './ServiceAccountCredentials';
import type { ServiceAccountCredentials } from './ServiceAccountCredentials';

interface BearerAuthenticators {
	external?: Authenticator;
	serviceAccounts?: ServiceAccountCredentials;
}

/** A presented bearer credential owns the request, including authentication failures. */
export function composeAuthenticators(
	tokens: TokenService,
	sso: Authenticator,
	{ external, serviceAccounts }: BearerAuthenticators = {},
): Authenticator {
	const logoutUrl = sso.logoutUrl?.bind(sso);
	return {
		async authenticate(request) {
			const bearer = parseBearerAuthorization(request);
			if (bearer.kind === 'invalid') return null;
			if (bearer.kind === 'bearer' && bearer.token.startsWith(SERVICE_ACCOUNT_PREFIX)) {
				return serviceAccounts?.verify(bearer.token) ?? null;
			}
			let principal: AuthenticatedPrincipal | null | undefined;
			if (bearer.kind === 'absent') {
				principal = await sso.authenticate(request);
			} else if (isPersonalAccessToken(bearer.token)) {
				principal = await tokens.verify(bearer.token);
			} else {
				principal = await external?.authenticate(request);
			}
			// SSO, external tokens, and PATs cannot claim a configured machine's identity.
			return principal?.id.startsWith(SERVICE_ACCOUNT_USER_PREFIX) ? null : (principal ?? null);
		},
		...(logoutUrl ? { logoutUrl } : {}),
	};
}
