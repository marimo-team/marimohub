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

/** A KEK is exactly one AES-256 key. Not a minimum: see {@link assertKeyMaterial}. */
const KEK_BYTES = 32;

/** `openssl rand -hex 32`. */
const HEX_KEK_REGEX = /^[0-9a-fA-F]{64}$/;

/** `openssl rand -base64 32`: 43 significant characters plus optional padding. */
const BASE64_KEK_REGEX = /^[A-Za-z0-9+/\-_]{43}=?$/;

/**
 * A degenerate-pattern floor. 32 uniformly random bytes hold ~30 distinct byte
 * values, so falling under this means a repeated or padded pattern
 * (`'ab'.repeat(32)`), not key material; a real key clears it with overwhelming
 * probability.
 */
const MIN_DISTINCT_BYTES = 16;

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
 * Rejects anything that is not shaped like a generated key: the KEK must be the
 * *canonical* encoding of exactly {@link KEK_BYTES} non-degenerate bytes — 64 hex
 * digits, or 43 base64 characters (one optional `=`) that re-encode to the input
 * unchanged and carry both cases, which is what rules out a lower-case phrase
 * that happens to fit the base64 shape (see {@link isGeneratedKey}).
 *
 * Requiring the exact shape rather than a byte floor is the point. HKDF is a
 * key-derivation function, not a password KDF — nothing here stretches the input
 * — so a memorable passphrase would leave every managed secret guessable, and a
 * long one *does* decode as base64: the alphabet is letters and digits, so
 * `'the-quick-brown-fox-jumps-over-the-lazy-dog'` yielded 32 "bytes" under a
 * byte-count check. This is not an entropy measurement; no check on a string can
 * be. It only makes a non-generated value hard to supply by accident, and tells
 * the operator the command that produces a valid one. The message never echoes
 * the value.
 *
 * The KEK *string* (not the decoded bytes) remains the HKDF input keying
 * material: the encoded form carries the same entropy, and re-deriving from the
 * decoded bytes would invalidate every envelope already in the bucket.
 */
function assertKeyMaterial(kek: string): void {
	if (!isGeneratedKey(kek)) {
		throw new Error(
			`Managed-secret KEK must be a generated ${KEK_BYTES}-byte key in its canonical ` +
				'encoding: 64 hex characters, or the 44-character output of ' +
				'`openssl rand -base64 32` (43 characters plus its `=` padding, which is ' +
				'optional), carrying the mixed case a random key has. A passphrase is ' +
				'rejected because no password ' +
				'stretching is applied to it. Secrets written under a previously accepted weak ' +
				'key cannot be decrypted with the new one and must be re-entered.',
		);
	}
}

function isGeneratedKey(kek: string): boolean {
	const bytes = decodeKek(kek);
	if (!bytes || new Set(bytes).size < MIN_DISTINCT_BYTES) return false;
	// Hex is single-case by construction. Base64 of a random 32-byte key misses a
	// case with probability ~4e-10, so demanding both costs a real key nothing and
	// turns away the lower-case word phrases that otherwise fit the 43-char shape.
	return HEX_KEK_REGEX.test(kek) || (/[a-z]/.test(kek) && /[A-Z]/.test(kek));
}

function decodeKek(kek: string): Uint8Array | undefined {
	if (HEX_KEK_REGEX.test(kek)) {
		const bytes = new Uint8Array(KEK_BYTES);
		for (let i = 0; i < KEK_BYTES; i++) {
			bytes[i] = Number.parseInt(kek.slice(i * 2, i * 2 + 2), 16);
		}
		return bytes;
	}
	if (!BASE64_KEK_REGEX.test(kek)) return undefined;
	let bytes: Uint8Array;
	try {
		bytes = fromBase64Url(kek.replace(/=$/, ''));
	} catch {
		return undefined;
	}
	// Re-encoding must reproduce the input. This rejects a 43rd character whose
	// unused low bits are set and an input mixing the two alphabets — neither is
	// something a base64 encoder emits.
	const url = toBase64Url(bytes);
	const std = url.replaceAll('-', '+').replaceAll('_', '/');
	return [url, `${url}=`, std, `${std}=`].includes(kek) ? bytes : undefined;
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
