/**
 * Authentication port.
 *
 * `Authenticator` establishes *who* a request comes from. Concrete adapters
 * (generic OIDC, Cloudflare Access, dev-bypass) live in their own packages and
 * implement this interface. The domain core stays framework- and vendor-free:
 * an adapter that needs to expose login/callback routes (e.g. the app-native
 * OIDC redirect flow) does so through its own package, not through this port.
 */
export interface AuthUser {
	id: string;
	email: string;
}

export interface Authenticator {
	/** Resolve identity from the incoming request, or null if unauthenticated. */
	authenticate(request: Request): Promise<AuthUser | null>;
	/** Optional provider end-session URL, surfaced by `GET /api/me`. */
	logoutUrl?(): string | null;
}
