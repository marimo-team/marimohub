/**
 * Minimal structured logger (Node control plane). Mirrors the helper in
 * `@marimo-hub/api` rather than importing it: `logEvent` is an internal util
 * that isn't part of the api package's public barrel, so duplicating the ~5
 * lines keeps the api/server boundary clean and avoids widening that surface.
 */
import { traceContext } from '@marimo-hub/core';

export function logEvent(fields: Record<string, unknown>): void {
	console.log(JSON.stringify({ ts: new Date().toISOString(), ...traceContext(), ...fields }));
}
