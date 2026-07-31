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
 * The KEK must be at least AES-256's own key length of random bytes. Length
 * alone proves nothing about entropy, hence the encoding requirement below.
 */
const MIN_KEK_BYTES = 32;

/**
 * A degenerate-pattern floor. 32 uniformly random bytes hold ~30 distinct byte
 * values, so falling under this means a repeated or padded pattern (`'k'*44`),
 * not key material; a real key clears it with overwhelming probability.
 */
const MIN_DISTINCT_BYTES = 16;

const HEX_REGEX = /^(?:[0-9a-f]{2})+$/i;
const BASE64_REGEX = /^[A-Za-z0-9+/\-_]+={0,2}$/;

const encoder = new TextEncoder();

export interface AesGcmSecretCodecOptions {
	/** Operator-held key material, not a user password. See {@link assertKeyMaterial}. */
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
		assertKeyMaterial(options.kek);
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
 * Rejects anything that is not plainly key material: the KEK must decode from
 * base64(url) or hex to at least {@link MIN_KEK_BYTES} non-degenerate bytes.
 * HKDF is a key-derivation function, not a password KDF — nothing here stretches
 * the input — so a memorable passphrase that merely reaches 32 characters would
 * leave every managed secret guessable. The message never echoes the value.
 *
 * The KEK *string* (not the decoded bytes) remains the HKDF input keying
 * material: the encoded form carries the same entropy, and re-deriving from the
 * decoded bytes would invalidate every envelope already in the bucket.
 */
function assertKeyMaterial(kek: string): void {
	const bytes = decodeKey(kek);
	if (!bytes || bytes.length < MIN_KEK_BYTES || new Set(bytes).size < MIN_DISTINCT_BYTES) {
		throw new Error(
			`Managed-secret KEK must be ${MIN_KEK_BYTES}+ random bytes encoded as base64 or hex ` +
				'(generate one with `openssl rand -base64 32`); a passphrase is rejected because no ' +
				'password stretching is applied to it. Secrets written under a previously accepted ' +
				'weak key cannot be decrypted with the new one and must be re-entered.',
		);
	}
}

function decodeKey(kek: string): Uint8Array | undefined {
	try {
		if (HEX_REGEX.test(kek)) {
			const bytes = new Uint8Array(kek.length / 2);
			for (let i = 0; i < bytes.length; i++) {
				bytes[i] = Number.parseInt(kek.slice(i * 2, i * 2 + 2), 16);
			}
			return bytes;
		}
		if (BASE64_REGEX.test(kek)) return fromBase64Url(kek.replace(/=+$/, ''));
	} catch {
		return undefined;
	}
	return undefined;
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
