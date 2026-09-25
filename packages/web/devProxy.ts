export function envPort(value: string | undefined, fallback: number): number {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : fallback;
}

function isIpv6Unspecified(hostname: string): boolean {
	if (!hostname.includes(':')) return false;
	try {
		return new URL(`http://[${hostname}]`).hostname === '[::]';
	} catch {
		return false;
	}
}

export function devApiTarget(env: Record<string, string | undefined>): string {
	const port = envPort(env.PORT, 3000);
	const configured = env.DEV_HOST?.trim() || '127.0.0.1';
	const hostname =
		configured === '0.0.0.0' ? '127.0.0.1' : isIpv6Unspecified(configured) ? '::1' : configured;
	return `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`;
}

export async function waitForDevApi(target: string, timeoutMs = 60_000): Promise<void> {
	const healthUrl = new URL('/api/health', target);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(healthUrl, {
				signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - Date.now()))),
			});
			const body: unknown = await response.json();
			if (
				response.ok &&
				body !== null &&
				typeof body === 'object' &&
				'status' in body &&
				body.status === 'ok'
			) {
				return;
			}
		} catch {
			// The API may not be listening yet while it initializes and seeds local data.
		}
		await new Promise((resolve) => {
			setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())));
		});
	}
	throw new Error(
		`Timed out waiting for the development API at ${healthUrl}. Check the API server logs.`,
	);
}
