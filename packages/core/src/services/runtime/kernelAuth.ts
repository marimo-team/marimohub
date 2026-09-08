import { toBase64Url } from '../../internal/base64url';
import { KERNEL_AUTH_TOKEN_PATTERN } from '../../schema';

export const KERNEL_AUTH_TOKEN_FILE = '/tmp/.marimohub-kernel-token';

const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'mhub_kernel_';

export function createKernelAuthToken(): string {
	return `${TOKEN_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))}`;
}

export function assertValidKernelAuthToken(token: string): void {
	if (!KERNEL_AUTH_TOKEN_PATTERN.test(token)) {
		throw new Error('Invalid kernel authentication token');
	}
}
