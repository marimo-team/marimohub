/** A pointer to a value held in an external secret manager. */
export interface SecretRef {
	/** Selects a registered SecretResolver, e.g. `aws-sm`. */
	backend: string;
	/** Manager-specific, e.g. `prod/ai#OPENAI_API_KEY` or an ARN[#key]. */
	locator: string;
}

export class SecretResolutionError extends Error {
	constructor(
		readonly reason: 'not_found' | 'invalid_value' | 'unavailable',
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = 'SecretResolutionError';
	}
}

/** Dereferences one integration secret. Implemented by `packages/secrets-*` adapters. */
export interface SecretResolver {
	/** Matches `SecretRef.backend`. */
	readonly backend: string;
	readonly title: string;
	readonly locatorPlaceholder: string;
	readonly locatorHelp: string;
	readonly docsUrl?: string;
	/** → plaintext. MUST throw a safe error without echoing the ref on failure. */
	resolve(ref: SecretRef): Promise<string>;
}

/** Envelope for a hub-held (managed) value — ciphertext only, no plaintext at rest. */
export interface SecretEnvelope {
	kek_id: string;
	alg: 'A256GCM';
	/** base64 */
	iv: string;
	/** base64 */
	ciphertext: string;
}

/**
 * Crypto for inline integration secrets. The integration store passes the field's
 * storage context so no two integration fields share a key/IV derivation.
 */
export interface ManagedSecretCodec {
	encrypt(plaintext: string, context: { path: string }): Promise<SecretEnvelope>;
	decrypt(envelope: SecretEnvelope, context: { path: string }): Promise<string>;
}
