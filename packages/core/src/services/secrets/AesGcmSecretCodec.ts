/**
 * Encrypted-in-bucket {@link ManagedSecretCodec}: AES-256-GCM under a per-object
 * key derived from an operator-held KEK via HKDF-SHA256, so the bucket only ever
 * sees ciphertext and no two objects share a key. The object `path` is the HKDF
 * `info`, which cryptographically binds an envelope to the object it was written
 * for — an envelope copied to another path fails to decrypt.
 *
 * Uses Web Crypto (`crypto.subtle`) rather than `node:crypto`, keeping `core`
 * vendor- and runtime-agnostic (runs identically on Node and Workers).
 */
import type { ManagedSecretCodec, SecretEnvelope } from '../../ports/secrets';
import { ValidationError } from '../../errors';
import { fromBase64Url, toBase64Url } from '../../internal/base64url';

/** AES-GCM's standard nonce size; a fresh IV is generated for every encryption. */
const IV_BYTES = 12;

/**
 * High-entropy KEKs only — this is key material, not a password (no stretching
 * is applied), so a short value would make the whole store brute-forceable.
 */
const MIN_KEK_CHARS = 32;

const encoder = new TextEncoder();

export interface AesGcmSecretCodecOptions {
	/** Operator-held key material, not a user password. */
	kek: string;
	/**
	 * Label stamped on envelopes and checked on decrypt, so a KEK swap fails with
	 * "unknown KEK" instead of a bare cipher error. Defaults to a digest-derived
	 * fingerprint of the KEK.
	 */
	kekId?: string;
}

export class AesGcmSecretCodec implements ManagedSecretCodec {
	private readonly kek: string;
	private readonly kekId: Promise<string>;

	constructor(options: AesGcmSecretCodecOptions) {
		if (options.kek.length < MIN_KEK_CHARS) {
			throw new Error(`Managed-secret KEK must be at least ${MIN_KEK_CHARS} characters`);
		}
		this.kek = options.kek;
		this.kekId = options.kekId ? Promise.resolve(options.kekId) : fingerprint(options.kek);
	}

	async encrypt(plaintext: string, context: { path: string }): Promise<SecretEnvelope> {
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const key = await this.deriveKey(context.path, 'encrypt');
		const ciphertext = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv },
			key,
			encoder.encode(plaintext),
		);
		return {
			kek_id: await this.kekId,
			alg: 'A256GCM',
			iv: toBase64Url(iv),
			ciphertext: toBase64Url(new Uint8Array(ciphertext)),
		};
	}

	async decrypt(envelope: SecretEnvelope, context: { path: string }): Promise<string> {
		// Failure messages name the object, never key material or plaintext.
		if (envelope.kek_id !== (await this.kekId)) {
			throw new ValidationError(
				`Cannot decrypt "${context.path}": it was encrypted under a different KEK ` +
					`("${envelope.kek_id}") than the one configured.`,
			);
		}
		try {
			const key = await this.deriveKey(context.path, 'decrypt');
			const plaintext = await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: toUint8(fromBase64Url(envelope.iv)) },
				key,
				toUint8(fromBase64Url(envelope.ciphertext)),
			);
			return new TextDecoder().decode(plaintext);
		} catch (err) {
			if (err instanceof ValidationError) throw err;
			throw new ValidationError(
				`Cannot decrypt "${context.path}": the envelope is corrupt or was encrypted ` +
					'under different key material.',
			);
		}
	}

	private async deriveKey(path: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
		const ikm = await crypto.subtle.importKey('raw', encoder.encode(this.kek), 'HKDF', false, [
			'deriveKey',
		]);
		return crypto.subtle.deriveKey(
			{
				name: 'HKDF',
				hash: 'SHA-256',
				// A fixed salt is fine for HKDF's extract step when the IKM is already
				// high-entropy; per-object separation comes from `info` (the path).
				salt: encoder.encode('marimohub/managed-secret/v1'),
				info: encoder.encode(path),
			},
			ikm,
			{ name: 'AES-GCM', length: 256 },
			false,
			[usage],
		);
	}
}

/**
 * Short KEK fingerprint for `kek_id`. A truncated hash of a domain-tagged,
 * high-entropy input — reveals nothing usable about the KEK, and gives rotation
 * a stable label to distinguish "wrong key" from "corrupt envelope".
 */
async function fingerprint(kek: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		encoder.encode(`marimohub/kek-id/v1:${kek}`),
	);
	return `kek-${toBase64Url(new Uint8Array(digest)).slice(0, 12)}`;
}

/** Re-wraps decoded bytes in the ArrayBuffer-backed view required by Web Crypto. */
function toUint8(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.length);
	copy.set(bytes);
	return copy;
}
