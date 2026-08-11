import type { ConfigSummary } from '@marimo-hub/api';
import type { Env } from './env';
import { readFolded } from './env';
import type { ConfigBackend } from './spec';
import { CONFIG_SPEC } from './spec';

/**
 * Assemble the read-only configuration summary served by the super-admin
 * settings endpoint. Derived from `CONFIG_SPEC` (not hand-listed) so new vars
 * show up without touching this file, and so the spec's `secret` flag is the
 * single source of truth for redaction: a secret var only reports whether it
 * is set — its value is never copied out of the env.
 *
 * Per group, the vars shown are the selected backend's (per the group's
 * selector env var, falling back to the spec default) plus any pseudo-backend
 * vars that apply regardless of selection.
 */
export function buildConfigSummary(env: Env): ConfigSummary {
	return {
		groups: CONFIG_SPEC.map((group) => {
			// Fold the selector exactly like the wiring does: every selector validates
			// through parseEnum, so the directory tracks the backend actually selected.
			const backend = group.selector
				? (readFolded(env, group.selector) ?? group.selectorDefault ?? 'unset')
				: null;
			const applies = (b: ConfigBackend) =>
				b.selectorValue === undefined || b.selectorValue === backend;
			return {
				name: group.name,
				backend,
				settings: group.backends.filter(applies).flatMap((b) =>
					b.vars.map((v) => {
						const secret = v.secret === true;
						const raw = env[v.id];
						return {
							key: v.id,
							name: v.name,
							value: secret ? null : (raw ?? v.default ?? null),
							secret,
							set: raw !== undefined,
						};
					}),
				),
			};
		}),
	};
}
