import { decodeTime } from 'ulidx';
import { toHex } from '../../internal/hex';

const SECRET_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const SECRET_LENGTH = 32;

export function generateAuthorizationSecret(): string {
	const bytes = new Uint8Array(SECRET_LENGTH);
	crypto.getRandomValues(bytes);
	let secret = '';
	for (let index = 0; index < SECRET_LENGTH; index += 1) {
		secret += SECRET_ALPHABET[bytes[index] & 31];
	}
	return secret;
}

export async function authorizationSha256(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function hashAuthorizationSecret(value: string): Promise<string> {
	return toHex(await authorizationSha256(value));
}

export async function createAuthorizationCode<T extends string>(createId: () => T, ttlMs: number) {
	const id = createId();
	const secret = generateAuthorizationSecret();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + ttlMs);
	return {
		id,
		secret,
		expiresAt,
		common: {
			id,
			code_hash: await hashAuthorizationSecret(secret),
			created_at: now.toISOString(),
			expires_at: expiresAt.toISOString(),
		},
	};
}

export function authorizationCreatedAt(key: string, prefix: string): number | null {
	if (!key.startsWith(prefix) || !key.endsWith('.json')) return null;
	const encodedId = key.slice(prefix.length, -'.json'.length);
	try {
		return decodeTime(encodedId);
	} catch {
		return null;
	}
}
