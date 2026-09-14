import { toHex } from './hex';

export async function sha256Hex(value: string): Promise<string> {
	return toHex(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
	);
}
