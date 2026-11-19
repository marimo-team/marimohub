import { toHex } from './hex';

export async function sha256(value: string | Uint8Array): Promise<Uint8Array> {
	const bytes =
		typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
	return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
	return toHex(await sha256(value));
}
