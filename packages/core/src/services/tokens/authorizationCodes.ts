import { decodeTime } from 'ulidx';
import { sha256Hex } from '../../internal/sha256';

export { sha256 as authorizationSha256 } from '../../internal/sha256';

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

export async function hashAuthorizationSecret(value: string): Promise<string> {
	return sha256Hex(value);
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

export function authorizationCreatedAt(
	key: string,
	prefix: string,
	isAuthorizationId: (value: unknown) => boolean,
): number | null {
	if (!key.startsWith(prefix) || !key.endsWith('.json')) return null;
	const encodedId = key.slice(prefix.length, -'.json'.length);
	if (!isAuthorizationId(encodedId)) return null;
	try {
		return decodeTime(encodedId);
	} catch {
		return null;
	}
}
