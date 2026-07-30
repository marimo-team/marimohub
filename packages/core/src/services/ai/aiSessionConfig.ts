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
import { serializeMarimoToml } from '../marimoConfig';
import type { MarimoConfigContributor, TomlTable } from '../marimoConfig';

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

/** Claims carried by an AI session token; `sessionId` is the JWT `sub`. */
export interface AiTokenClaims {
	projectId: string;
	notebookId: string;
	sessionId: string;
	userId: string;
}

/**
 * The marimo `[ai]` config as a mergeable fragment: a named custom provider
 * pointed at the proxy. A named provider (NOT `[ai.open_ai]`) avoids polluting
 * the editor's default OpenAI model list with entries that don't route to the
 * proxy. It also pins marimo to pydantic-ai's `OpenAIChatModel`
 * (`POST /v1/chat/completions`); the built-in `[ai.open_ai]` provider would use
 * `OpenAIResponsesModel` (`POST /v1/responses`) instead — the proxy handles both,
 * but the custom provider is the tested path.
 */
function aiConfigTable(config: AiSessionConfig): TomlTable {
	const modelRef = `${MARIMOHUB_AI_PROVIDER}/${config.model}`;
	const ai: TomlTable = { enabled: config.enabled !== false };
	if (config.maxTokens !== undefined) ai.max_tokens = config.maxTokens;
	if (config.rules) ai.rules = config.rules;
	ai.models = {
		chat_model: modelRef,
		edit_model: modelRef,
		autocomplete_model: modelRef,
	};
	ai.custom_providers = {
		[MARIMOHUB_AI_PROVIDER]: { base_url: config.baseUrl, api_key: config.apiKey },
	};
	return { ai };
}

export function buildMarimoAiToml(config: AiSessionConfig): string {
	return serializeMarimoToml(aiConfigTable(config));
}

export function marimoAiContributor(config: AiSessionConfig): MarimoConfigContributor {
	return () => aiConfigTable(config);
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
