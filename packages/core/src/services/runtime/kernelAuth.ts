import { toBase64Url } from '../../internal/base64url';

export const KERNEL_AUTH_TOKEN_FILE = '/tmp/.marimohub-kernel-token';

const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'mhub_kernel_';

export function createKernelAuthToken(): string {
	return `${TOKEN_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))}`;
}
