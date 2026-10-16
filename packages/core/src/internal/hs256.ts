import { fromBase64Url, toBase64Url, utf8ToBase64Url } from './base64url';
import { hmacSha256, timingSafeEqual } from './hmac';

export async function signHs256Token(
	secret: string,
	payload: Record<string, unknown>,
): Promise<string> {
	const input = `${utf8ToBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${utf8ToBase64Url(JSON.stringify(payload))}`;
	return `${input}.${toBase64Url(await hmacSha256(secret, input))}`;
}

// Verifies the signature and decodes the payload; callers enforce expiry and claim scope.
export async function verifyHs256Token(
	secret: string,
	token: string,
): Promise<Record<string, unknown> | null> {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [header, payload, signature] = parts;
	let provided: Uint8Array;
	try {
		provided = fromBase64Url(signature);
	} catch {
		return null;
	}
	const expected = await hmacSha256(secret, `${header}.${payload}`);
	if (!timingSafeEqual(expected, provided)) return null;
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
		return typeof parsed === 'object' && parsed !== null
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
