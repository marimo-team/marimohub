function safeError(err: unknown): Record<string, unknown> {
	if (!(err instanceof Error)) return { name: `non-error(${typeof err})` };
	const value = err as Error & {
		code?: unknown;
		status?: unknown;
		operation?: unknown;
		reason?: unknown;
		object?: unknown;
		issues?: { path?: unknown; code?: unknown }[];
		cause_name?: unknown;
	};
	const out: Record<string, unknown> = { name: value.name };
	for (const key of ['code', 'status', 'operation', 'reason', 'object', 'cause_name'] as const) {
		const field = value[key];
		if (typeof field === 'number') out[key] = field;
		if (typeof field === 'string' && field.length <= 256) out[key] = field;
	}
	if (Array.isArray(value.issues)) {
		out.issues = value.issues.map((issue) => ({
			path: typeof issue.path === 'string' ? issue.path : undefined,
			code: typeof issue.code === 'string' ? issue.code : undefined,
		}));
	}
	return out;
}

/** Emit a fail-open error without serializing arbitrary exception text or stored values. */
export function logOperationalError(
	event: string,
	fields: Record<string, unknown>,
	err: unknown,
): void {
	console.error(
		JSON.stringify({
			ts: new Date().toISOString(),
			level: 'error',
			event,
			...fields,
			error: safeError(err),
		}),
	);
}
