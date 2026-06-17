/**
 * Authentication port.
 *
 * `Authenticator` establishes *who* a request comes from. Concrete adapters
 * (generic OIDC, Cloudflare Access, dev-bypass) live in their own packages and
 * implement this interface. The domain core stays framework- and vendor-free:
 * an adapter that needs to expose login/callback routes (e.g. the app-native
 * OIDC redirect flow) does so through its own package, not through this port.
 */
import type { UserId } from '../ids';

export interface AuthUser {
	id: UserId;
	email: string;
	/**
	 * Human-readable display name, when the identity provider supplies one (e.g.
	 * the OIDC `name` claim). Optional: adapters that can't source a name leave it
	 * undefined, and consumers fall back to the email. Persisted into the identity
	 * directory so opaque user ids (`sub`) can be rendered as a person.
	 */
	name?: string;
}

export interface Authenticator {
	/** Resolve identity from the incoming request, or null if unauthenticated. */
	authenticate(request: Request): Promise<AuthUser | null>;
	/** Optional provider end-session URL, surfaced by `GET /api/v1/me`. */
	logoutUrl?(): string | null;
}
