/**
 * Minimal, dependency-free structured logger. Emits one JSON object per event so
 * lines are machine-parseable in log aggregators (no pino/winston — keeps the
 * Cloudflare Workers build dependency-free).
 */
export function logEvent(fields: Record<string, unknown>): void {
	console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}
