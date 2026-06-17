/**
 * Managed-AI session config: builds the marimo AI configuration injected into a
 * sandbox at provision time, and mints/verifies the short-lived token that
 * authorizes the sandbox to marimohub's AI proxy.
 *
 * Sandboxes run untrusted notebook code, so the real upstream provider key is
 * NEVER written into them. Instead each session gets an HMAC-signed, expiring,
 * session-scoped token (mirroring `proxyToken.ts`); the proxy swaps it for the
 * real key. Uses Web Crypto (`crypto.subtle`) so it runs identically on Node and
 * Workers, keeping `core` vendor- and runtime-agnostic.
 */
import { Millis, Seconds } from '../../duration';
import { fromBase64Url, toBase64Url, utf8ToBase64Url } from '../../internal/base64url';
import { hmacSha256, timingSafeEqual } from '../../internal/hmac';

/** The marimo custom-provider name our config registers (routes `<name>/<model>`). */
export const MARIMOHUB_AI_PROVIDER = 'marimohub';

/** Default token lifetime — long enough to outlive a typical editing session. */
const DEFAULT_AI_TOKEN_TTL_SECONDS = Seconds.hours(1);

export interface AiSessionConfig {
	/** OpenAI-compatible proxy base URL; MUST end in `/v1`. */
	baseUrl: string;
	/** The minted per-session token marimo sends as the provider `api_key`. */
	apiKey: string;
	/** Bare upstream model id (surfaced to marimo as `marimohub/<model>`). */
	model: string;
	enabled?: boolean;
	maxTokens?: number;
	rules?: string;
}

export interface SessionEnvFragment {
	files: { path: string; content: string }[];
	vars: Record<string, string>;
}

/** Claims carried by an AI session token; `sessionId` is the JWT `sub`. */
export interface AiTokenClaims {
	projectId: string;
	notebookId: string;
	sessionId: string;
	userId: string;
}

/** Escape a value into a TOML basic string (double-quoted). */
function tomlString(value: string): string {
	const escaped = value
		.replaceAll('\\', '\\\\')
		.replaceAll('"', '\\"')
		.replaceAll('\n', '\\n')
		.replaceAll('\r', '\\r')
		.replaceAll('\t', '\\t');
	return `"${escaped}"`;
}

/**
 * Render the marimo `[ai]` config that points a named custom provider at the
 * proxy. A named provider (NOT `[ai.open_ai]`) avoids polluting the editor's
 * default OpenAI model list with entries that don't route to the proxy. It also
 * pins marimo to pydantic-ai's `OpenAIChatModel` (`POST /v1/chat/completions`);
 * the built-in `[ai.open_ai]` provider would use `OpenAIResponsesModel`
 * (`POST /v1/responses`) instead — the proxy handles both, but the custom provider
 * is the tested path.
 */
export function buildMarimoAiToml(config: AiSessionConfig): string {
	const modelRef = `${MARIMOHUB_AI_PROVIDER}/${config.model}`;
	const lines = ['[ai]', `enabled = ${config.enabled === false ? 'false' : 'true'}`];
	if (config.maxTokens !== undefined) lines.push(`max_tokens = ${config.maxTokens}`);
	if (config.rules) lines.push(`rules = ${tomlString(config.rules)}`);
	lines.push(
		'',
		'[ai.models]',
		`chat_model = ${tomlString(modelRef)}`,
		`edit_model = ${tomlString(modelRef)}`,
		`autocomplete_model = ${tomlString(modelRef)}`,
		'',
		`[ai.custom_providers.${MARIMOHUB_AI_PROVIDER}]`,
		`base_url = ${tomlString(config.baseUrl)}`,
		`api_key = ${tomlString(config.apiKey)}`,
		'',
	);
	return lines.join('\n');
}

/**
 * Shape the marimo config as a sandbox env fragment: a `marimo.toml` under an
 * XDG config dir plus `XDG_CONFIG_HOME` pointing at it. The dir lives OUTSIDE the
 * notebook's mount path, so the token/url are never read back into the committed
 * `pyproject.toml` or captured into the workspace.
 */
export function aiConfigToSessionEnv(config: AiSessionConfig, xdgPath: string): SessionEnvFragment {
	const dir = xdgPath.replace(/\/+$/, '');
	return {
		files: [{ path: `${dir}/marimo/marimo.toml`, content: buildMarimoAiToml(config) }],
		vars: { XDG_CONFIG_HOME: dir },
	};
}

/** Mint a short-lived HS256 JWT scoped to one session, signed with `secret`. */
export async function mintAiSessionToken(
	secret: string,
	claims: AiTokenClaims,
	opts: { ttlSeconds?: Seconds; now?: () => number } = {},
): Promise<string> {
	const now = opts.now ?? (() => Date.now());
	const iat = Millis.toSeconds(Millis.of(now()));
	const exp = iat + (opts.ttlSeconds ?? DEFAULT_AI_TOKEN_TTL_SECONDS);
	const header = { alg: 'HS256', typ: 'JWT' };
	const payload = {
		sub: claims.sessionId,
		project_id: claims.projectId,
		notebook_id: claims.notebookId,
		user_id: claims.userId,
		iat,
		exp,
	};
	const signingInput = `${utf8ToBase64Url(JSON.stringify(header))}.${utf8ToBase64Url(
		JSON.stringify(payload),
	)}`;
	const sig = await hmacSha256(secret, signingInput);
	return `${signingInput}.${toBase64Url(sig)}`;
}

/**
 * Verify an AI session token: signature + expiry. Returns the claims, or `null`
 * if the token is malformed, forged, or expired.
 */
export async function verifyAiSessionToken(
	secret: string,
	token: string,
	now: () => number = () => Date.now(),
): Promise<AiTokenClaims | null> {
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [headerB64, payloadB64, sigB64] = parts;
	let providedSig: Uint8Array;
	try {
		providedSig = fromBase64Url(sigB64);
	} catch {
		return null;
	}
	const expectedSig = await hmacSha256(secret, `${headerB64}.${payloadB64}`);
	if (!timingSafeEqual(expectedSig, providedSig)) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const payload = parsed as Record<string, unknown>;
	if (typeof payload.exp !== 'number' || payload.exp < Millis.toSeconds(Millis.of(now()))) {
		return null;
	}
	const { sub, project_id, notebook_id, user_id } = payload;
	if (
		typeof sub !== 'string' ||
		typeof project_id !== 'string' ||
		typeof notebook_id !== 'string' ||
		typeof user_id !== 'string'
	) {
		return null;
	}
	return { sessionId: sub, projectId: project_id, notebookId: notebook_id, userId: user_id };
}
