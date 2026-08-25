import { BlockList, isIP } from 'node:net';

const LOOPBACK_ADDRESSES = new BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');
LOOPBACK_ADDRESSES.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

export function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, '');
	if (normalized === 'localhost') return true;
	const family = isIP(normalized);
	return family !== 0 && LOOPBACK_ADDRESSES.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

export function resolveDevHostname(
	env: Record<string, string | undefined>,
	warn: (message: string) => void = console.warn,
): string {
	const hostname = env.DEV_HOST?.trim() || '127.0.0.1';
	if (!isLoopbackHostname(hostname)) {
		warn(
			`[marimohub] DEV_HOST=${hostname} exposes the development server with its unauthenticated super-admin identity.`,
		);
	}
	return hostname;
}
