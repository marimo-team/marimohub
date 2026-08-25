export function envPort(value: string | undefined, fallback: number): number {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : fallback;
}

export function devApiTarget(env: Record<string, string | undefined>): string {
	const port = envPort(env.PORT, 3000);
	const configured = env.DEV_HOST?.trim() || '127.0.0.1';
	const hostname =
		configured === '0.0.0.0'
			? '127.0.0.1'
			: configured === '::' || configured === '0:0:0:0:0:0:0:0'
				? '::1'
				: configured;
	return `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`;
}
