import { z } from 'zod';
import type {
	IntegrationCategory,
	IntegrationProbe,
	TestResult,
	UiHints,
} from '../../ports/integrations';
import type { ProjectId, SessionId, UserId } from '../../ids';
import { secretPaths } from './secretFields';
import type { SecretPath } from './secretFields';

export interface RenderInput<C> {
	/** Validated config with secret fields resolved to plaintext. */
	config: C;
	/** Instance name used to parameterize paths and environment variables. */
	instanceName: string;
	projectId: ProjectId;
	principal: { userId: UserId; email: string };
	session: { sessionId: SessionId };
}

export interface RenderOutput {
	/**
	 * Files to place in the sandbox, paths relative to the integrations dir
	 * (POSIX separators, no `..`). The bundler prefixes the absolute dir and
	 * hard-errors on cross-integration path collisions.
	 */
	files?: { path: string; content: string }[];
	/**
	 * Structured YAML fragments sharing a path are recursively merged by the
	 * bundler. Conflicting leaves fail closed.
	 */
	yamlFiles?: { path: string; value: Record<string, unknown> }[];
	/**
	 * Env vars to inject. Kind-authored names (not user input) — validated for
	 * POSIX shape and shell-vector safety by the bundler; two integrations
	 * emitting the same key with different values is a hard error.
	 */
	env?: Record<string, string>;
	/** User-safe metadata copied into this instance's manifest entry. */
	manifestExtra?: Record<string, unknown>;
}

/** Complete contract for one registered integration kind. */
export interface IntegrationDefinition<S extends z.ZodType = z.ZodType> {
	/** Registry discriminator. Stable forever; a rename is a migration. */
	kind: string;
	title: string;
	description: string;
	category: IntegrationCategory;
	/**
	 * Version of the config *shape*. Bump on an incompatible schema change and
	 * provide `migrate` for stored configs — a live old version without a migrate
	 * path fails loudly at render, never silently.
	 */
	schemaVersion: number;
	/** Source of truth for validation, JSON Schema, forms, and secret paths. */
	configSchema: S;
	/** Presentation hints keyed by dotted config paths. */
	uiHints?: UiHints;
	/**
	 * Informational only: sandboxes do not preflight or install these packages.
	 */
	requirements?: string[];
	/**
	 * Pure and synchronous: same input → byte-identical output. No clock, RNG,
	 * network, or storage — anything session-specific arrives via the input.
	 */
	render(input: RenderInput<z.infer<S>>): RenderOutput;
	/**
	 * Optional write-time check for rules Zod cannot express in JSON Schema
	 * (reserved names, cross-field constraints). Runs after schema validation
	 * with secret values replaced by placeholders — never inspect them here.
	 * Throw `ValidationError` to reject.
	 */
	validate?(config: z.infer<S>): void;
	/**
	 * Optional connectivity probe behind the UI's "Test" button. Runs server-side
	 * with the (resolved) config; the result must never echo secret material —
	 * `defineIntegration` redacts details that quote a schema-marked value.
	 * ALL network access goes through `probe` (never ambient `fetch`) — it is the
	 * deployment's egress-policy boundary, and testing is disabled when none is
	 * wired.
	 */
	testConnection?(config: z.infer<S>, probe: IntegrationProbe): Promise<TestResult>;
	/**
	 * Upgrade a stored config from an older `schemaVersion`. Chainable per step.
	 * Operates on the STORED shape (secret fields are `{ $secret: … }` boxes) and
	 * must carry those boxes through untouched. It may NOT move a `zSecret` field
	 * to a different path: envelopes are cryptographically bound to their field
	 * path, so a moved box fails to decrypt (and one left behind is rejected by
	 * the stray-box guard). Renaming a secret path needs a decrypt-and-reseal
	 * migration helper — deliberately not built until a kind needs it.
	 */
	migrate?(stored: unknown, fromVersion: number): unknown;
}

/**
 * Preserves schema inference across a complete integration definition, and wraps
 * `testConnection` in the secret guard below.
 */
export function defineIntegration<S extends z.ZodType>(
	def: IntegrationDefinition<S>,
): IntegrationDefinition<S> {
	const testConnection = def.testConnection?.bind(def);
	if (!testConnection) return def;
	let paths: SecretPath[] | undefined;
	return {
		...def,
		async testConnection(config, probe) {
			const result = await testConnection(config, probe);
			paths ??= secretPaths(
				z.toJSONSchema(def.configSchema, { io: 'input' }) as Record<string, unknown>,
			);
			return withoutSecretEcho(result, config, paths);
		},
	};
}

/**
 * A kind's own view of where its secrets live is not the boundary: configs carry
 * secret material outside the auth block (Trino custom headers and extra
 * credentials, storage credentials), so an `auth: none` test whose transport
 * quotes the offending header would echo it through `err.message`. Enforce the
 * contract centrally against the schema-marked paths instead.
 */
function withoutSecretEcho(result: TestResult, config: unknown, paths: SecretPath[]): TestResult {
	const { details } = result;
	if (details === undefined || details === '') return result;
	const echoes = collectSecretValues(config, paths).some((value) =>
		secretForms(value).some((form) => details.includes(form)),
	);
	if (!echoes) return result;
	// The substring match stays deliberately blunt (a short secret matches an
	// innocuous detail by chance), so the replacement tracks the result's own
	// `ok` instead of asserting failure: a false positive then costs detail, not
	// correctness.
	return { ...result, details: result.ok ? 'connected' : 'request failed' };
}

/**
 * Shapes a secret can take on the way into a transport error message. The
 * JSON-escaped body matters because a message built from `JSON.stringify` of the
 * request turns a quote, backslash, newline, tab, or control character into an
 * escape sequence that the raw substring no longer matches. A value without
 * those characters encodes to itself, so this never widens the match.
 *
 * `encodeURIComponent` throws on a lone surrogate, which a JSON config can carry
 * (`"\ud800"`). Dropping just that form keeps the guard working instead of
 * letting a URIError escape `testConnection` as a 500.
 */
function secretForms(value: string): string[] {
	const forms = [value, JSON.stringify(value).slice(1, -1)];
	try {
		forms.push(encodeURIComponent(value));
	} catch {
		// Not URL-encodable, so no transport can echo it in that form either.
	}
	return forms;
}

/** Plaintext values sitting at the kind's schema-marked secret paths. */
function collectSecretValues(config: unknown, paths: SecretPath[]): string[] {
	const marked = new Set(paths.map((path) => path.join('.')));
	const values: string[] = [];
	const walk = (value: unknown, path: string[]): void => {
		if (typeof value === 'string') {
			if (marked.has(path.join('.'))) values.push(value);
		} else if (Array.isArray(value)) {
			for (const item of value) walk(item, [...path, '*']);
		} else if (typeof value === 'object' && value !== null) {
			for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
		}
	};
	walk(config, []);
	return values;
}

export function envSegment(instanceName: string): string {
	return instanceName.toUpperCase().replaceAll('-', '_');
}

/**
 * Bare hostname (or IP literal) — no scheme, port, path, userinfo, or spaces —
 * so a host interpolated into a rendered URL cannot smuggle extra URL structure.
 */
export const HOSTNAME_REGEX = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * `Authorization: Basic` value via UTF-8 → base64 (bare `btoa` throws on
 * non-Latin-1 credentials, which would surface as a 500 instead of a result).
 */
export function basicAuthHeader(username: string, password: string): string {
	const bytes = new TextEncoder().encode(`${username}:${password}`);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `Basic ${btoa(binary)}`;
}

/**
 * `containsSecrets` is the kind's own fast path for a request it knows carried
 * credentials; secrets living elsewhere in the config are caught by
 * `defineIntegration`'s guard, so never treat this flag as the whole boundary.
 */
export function probeErrorDetails(err: unknown, containsSecrets: boolean): string {
	if (containsSecrets) return 'request failed';
	return err instanceof Error ? err.message : 'request failed';
}
