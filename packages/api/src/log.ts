/**
 * Minimal, dependency-free structured logger. Emits one JSON object per event so
 * lines are machine-parseable in log aggregators (no pino/winston — keeps the
 * Cloudflare Workers build dependency-free).
 */
export function logEvent(fields: Record<string, unknown>): void {
	console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

/**
 * An error's identity with no free-form text — enough to triage a provider
 * failure from a log line. For the errors {@link describeError} is unsafe on:
 * ones whose message or causes can quote credential material.
 */
export function errorMetadata(err: unknown): Record<string, string | number> {
	// Not even `String(err)` — a thrown non-Error may BE the secret.
	if (!(err instanceof Error)) return { error_name: `non-error(${typeof err})` };
	const e = err as Error & { code?: unknown; status?: unknown; operation?: unknown };
	const out: Record<string, string | number> = { error_name: e.name };
	for (const [key, value] of [
		['error_code', e.code],
		['error_status', e.status],
		['error_operation', e.operation],
	] as const) {
		// Enum-ish identifiers only — anything else is free-form text of unknown origin.
		if (typeof value === 'number') out[key] = value;
		if (typeof value === 'string' && value.length <= 64) out[key] = value;
	}
	return out;
}

export async function bestEffort(
	operation: string,
	fields: Record<string, unknown>,
	action: () => Promise<unknown>,
): Promise<void> {
	try {
		await action();
	} catch (err) {
		logEvent({
			level: 'error',
			event: 'best_effort_operation_failed',
			operation,
			...fields,
			error: errorMetadata(err),
		});
	}
}

/**
 * Extract a rich, JSON-serializable description of an error for SERVER logs:
 * name, message, stack, and any duck-typed vendor fields (gRPC `transportCode`,
 * `operation`, SDK `code`), plus the `cause` chain. Read by duck-typing only — no
 * adapter/SDK import — so it stays usable from `api`/`core` without breaking the
 * dependency rule. This is for logs, never returned to clients.
 *
 * It performs NO redaction: never hand it (or attach as `cause`) an error whose
 * text may quote a secret — use {@link errorMetadata} for those.
 */
export function describeError(err: unknown, depth = 3): Record<string, unknown> {
	if (!(err instanceof Error)) return { value: String(err) };
	const e = err as Error & {
		code?: unknown;
		transportCode?: unknown;
		operation?: unknown;
		cause?: unknown;
		reason?: unknown;
		object?: unknown;
		cause_name?: unknown;
		issues?: { path?: unknown[] | string; message?: string; code?: string }[];
	};
	const out: Record<string, unknown> = { name: e.name, message: e.message };
	if (e.stack) out.stack = e.stack;
	if (e.code !== undefined) out.code = e.code;
	if (e.transportCode !== undefined) out.transportCode = e.transportCode;
	if (e.operation !== undefined) out.operation = e.operation;
	if (e.reason !== undefined) out.reason = e.reason;
	if (e.object !== undefined) out.object = e.object;
	if (e.cause_name !== undefined) out.cause_name = e.cause_name;
	// ZodError (duck-typed): surface the failing field paths so a corrupted stored
	// object is identifiable from the log instead of a bare stack.
	if (Array.isArray(e.issues)) {
		out.issues = e.issues.map((i) => ({
			path: Array.isArray(i.path) ? i.path.join('.') : i.path,
			...(i.code ? { code: i.code } : {}),
			...(i.message ? { message: i.message } : {}),
		}));
	}
	if (e.cause !== undefined && e.cause !== null && depth > 0) {
		out.cause = describeError(e.cause, depth - 1);
	}
	return out;
}
