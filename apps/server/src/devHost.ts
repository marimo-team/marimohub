const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

export function resolveDevHostname(
	env: Record<string, string | undefined>,
	warn: (message: string) => void = console.warn,
): string {
	const hostname = env.DEV_HOST?.trim() || '127.0.0.1';
	if (!LOOPBACK_HOSTNAMES.has(hostname.toLowerCase())) {
		warn(
			`[marimohub] DEV_HOST=${hostname} exposes the development server with its unauthenticated super-admin identity.`,
		);
	}
	return hostname;
}
