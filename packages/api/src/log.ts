/**
 * Minimal, dependency-free structured logger. Emits one JSON object per event so
 * lines are machine-parseable in log aggregators (no pino/winston — keeps the
 * Cloudflare Workers build dependency-free).
 */
export function logEvent(fields: Record<string, unknown>): void {
	console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

/**
 * Extract a rich, JSON-serializable description of an error for SERVER logs:
 * name, message, stack, and any duck-typed vendor fields (gRPC `transportCode`,
 * `operation`, SDK `code`), plus the `cause` chain. Read by duck-typing only — no
 * adapter/SDK import — so it stays usable from `api`/`core` without breaking the
 * dependency rule. This is for logs, never returned to clients.
 */
export function describeError(err: unknown, depth = 3): Record<string, unknown> {
	if (!(err instanceof Error)) return { value: String(err) };
	const e = err as Error & {
		code?: unknown;
		transportCode?: unknown;
		operation?: unknown;
		cause?: unknown;
		issues?: { path?: unknown[]; message?: string }[];
	};
	const out: Record<string, unknown> = { name: e.name, message: e.message };
	if (e.stack) out.stack = e.stack;
	if (e.code !== undefined) out.code = e.code;
	if (e.transportCode !== undefined) out.transportCode = e.transportCode;
	if (e.operation !== undefined) out.operation = e.operation;
	// ZodError (duck-typed): surface the failing field paths so a corrupted stored
	// object is identifiable from the log instead of a bare stack.
	if (Array.isArray(e.issues)) {
		out.issues = e.issues.map((i) => ({ path: i.path?.join('.'), message: i.message }));
	}
	if (e.cause !== undefined && e.cause !== null && depth > 0) {
		out.cause = describeError(e.cause, depth - 1);
	}
	return out;
}
