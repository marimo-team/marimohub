/**
 * Port: exchange a hub-issued OIDC JWT for temporary, scoped credentials. `core`
 * and the API depend only on this interface; a concrete broker (e.g. CoreWeave)
 * lives in its own adapter package, wired by `config`. The JWT is the sole
 * authentication for the exchange — no long-lived caller credential.
 */

/** Temporary S3-style credentials returned by a credential exchange. */
export interface TempS3Creds {
	accessKeyId: string;
	secretAccessKey: string;
	/** Session token, when the provider issues one (may be empty/omitted). */
	sessionToken?: string;
	/** ISO-8601 expiry, for logging / future refresh. */
	expiration?: string;
}

export interface CredentialBroker {
	/**
	 * Exchange a signed OIDC JWT for temporary S3 credentials. Implementations
	 * MUST NOT echo the JWT (or any returned secret) in thrown errors or logs.
	 */
	exchange(jwt: string): Promise<TempS3Creds>;
}

/**
 * A named, provider-neutral federation target: the broker that exchanges the
 * hub's JWT, the `aud` those JWTs must carry, and the object store the resulting
 * credentials address. A deployment registers one or more; a project selects one
 * by name.
 */
export interface FederationTarget {
	broker: CredentialBroker;
	/** Audience the minted JWT must carry; must match the cloud's WIF config. */
	audience: string;
	/**
	 * The object store the exchanged credentials address. `endpoint` is needed only
	 * for a non-AWS store (e.g. CoreWeave CAIOS at `cwobject.com`); omit it for AWS
	 * S3 and the SDK uses its default. Injected as `AWS_ENDPOINT_URL_S3`/`AWS_REGION`.
	 */
	storage: { endpoint?: string; region?: string };
}
