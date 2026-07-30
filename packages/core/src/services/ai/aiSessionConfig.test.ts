import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { Seconds } from '../../duration';
import { toBase64Url, utf8ToBase64Url } from '../../internal/base64url';
import { hmacSha256 } from '../../internal/hmac';
import { assembleMarimoToml } from '../marimoConfig';
import {
	buildMarimoAiToml,
	marimoAiContributor,
	MARIMOHUB_AI_PROVIDER,
	mintAiSessionToken,
	verifyAiSessionToken,
} from './aiSessionConfig';
import type { AiTokenClaims } from './aiSessionConfig';

const SECRET = 'test-session-secret';

/** Mint an HS256 token over an arbitrary payload, signed with `secret`. */
async function mintRaw(secret: string, payload: Record<string, unknown>): Promise<string> {
	const header = { alg: 'HS256', typ: 'JWT' };
	const signingInput = `${utf8ToBase64Url(JSON.stringify(header))}.${utf8ToBase64Url(
		JSON.stringify(payload),
	)}`;
	const sig = await hmacSha256(secret, signingInput);
	return `${signingInput}.${toBase64Url(sig)}`;
}
const CLAIMS: AiTokenClaims = {
	projectId: 'proj-1',
	notebookId: 'nb-1',
	sessionId: 'sess-1',
	userId: 'user-1',
};

describe('buildMarimoAiToml', () => {
	it('registers a named custom provider pointed at the proxy', () => {
		const toml = buildMarimoAiToml({
			baseUrl: 'https://app.example/api/ai/v1',
			apiKey: 'mh_token',
			model: 'gpt-4o-mini',
		});
		expect(toml).toContain(`[ai.custom_providers.${MARIMOHUB_AI_PROVIDER}]`);
		expect(toml).toContain('base_url = "https://app.example/api/ai/v1"');
		expect(toml).toContain('api_key = "mh_token"');
		expect(toml).toContain(`chat_model = "${MARIMOHUB_AI_PROVIDER}/gpt-4o-mini"`);
		expect(toml).toContain('enabled = true');
	});

	it('escapes quotes and backslashes in values', () => {
		const toml = buildMarimoAiToml({
			baseUrl: 'https://app.example/api/ai/v1',
			apiKey: 'a"b\\c',
			model: 'm',
			rules: 'be "concise"',
		});
		const config = parse(toml);
		expect(config.ai).toMatchObject({ rules: 'be "concise"' });
		expect(config.ai).toHaveProperty(`custom_providers.${MARIMOHUB_AI_PROVIDER}.api_key`, 'a"b\\c');
	});

	it('omits optional fields when absent', () => {
		const toml = buildMarimoAiToml({ baseUrl: 'u', apiKey: 'k', model: 'm' });
		expect(toml).not.toContain('max_tokens');
		expect(toml).not.toContain('rules');
	});

	it('emits enabled = false when enabled is false (does not silently force-enable)', () => {
		const toml = buildMarimoAiToml({ baseUrl: 'u', apiKey: 'k', model: 'm', enabled: false });
		expect(toml).toContain('enabled = false');
		expect(toml).not.toContain('enabled = true');
	});

	it('escapes newline, carriage-return, and tab in rules (no TOML string break-out)', () => {
		const rules = 'line1\nline2\rline3\tcol';
		const toml = buildMarimoAiToml({
			baseUrl: 'u',
			apiKey: 'k',
			model: 'm',
			rules,
		});
		expect(parse(toml).ai).toMatchObject({ rules });
	});
});

describe('marimoAiContributor', () => {
	it('produces the same [ai] sections as buildMarimoAiToml when assembled alone', () => {
		const config = { baseUrl: 'https://app.example/api/ai/v1', apiKey: 'mh_token', model: 'm' };
		const assembled = assembleMarimoToml([marimoAiContributor(config)]);
		expect(assembled).toBe(buildMarimoAiToml(config));
		expect(assembled).toContain(`[ai.custom_providers.${MARIMOHUB_AI_PROVIDER}]`);
	});
});

describe('AI session token', () => {
	it('round-trips mint -> verify', async () => {
		const token = await mintAiSessionToken(SECRET, CLAIMS);
		expect(await verifyAiSessionToken(SECRET, token)).toEqual(CLAIMS);
	});

	it('rejects a token signed with a different secret', async () => {
		const token = await mintAiSessionToken(SECRET, CLAIMS);
		expect(await verifyAiSessionToken('other-secret', token)).toBeNull();
	});

	it('rejects a tampered token', async () => {
		const token = await mintAiSessionToken(SECRET, CLAIMS);
		const tampered = `${token.slice(0, -2)}xy`;
		expect(await verifyAiSessionToken(SECRET, tampered)).toBeNull();
	});

	it('rejects a malformed token', async () => {
		expect(await verifyAiSessionToken(SECRET, 'not-a-jwt')).toBeNull();
	});

	it('rejects an expired token', async () => {
		const start = 1_000_000_000_000;
		const token = await mintAiSessionToken(SECRET, CLAIMS, {
			ttlSeconds: Seconds.of(60),
			now: () => start,
		});
		const later = () => start + 61_000;
		expect(await verifyAiSessionToken(SECRET, token, later)).toBeNull();
	});

	it('rejects a well-formed, correctly-signed token that is missing exp', async () => {
		const token = await mintRaw(SECRET, {
			sub: 'sess-1',
			project_id: 'proj-1',
			notebook_id: 'nb-1',
			user_id: 'user-1',
			iat: 1_000_000_000,
			// exp deliberately omitted — an unexpiring token must be rejected.
		});
		expect(await verifyAiSessionToken(SECRET, token)).toBeNull();
	});

	it('rejects a correctly-signed token missing a required claim (project_id)', async () => {
		const token = await mintRaw(SECRET, {
			sub: 'sess-1',
			notebook_id: 'nb-1',
			user_id: 'user-1',
			iat: 1_000_000_000,
			exp: 9_999_999_999,
		});
		expect(await verifyAiSessionToken(SECRET, token)).toBeNull();
	});

	it('treats exp exactly equal to now as still valid (boundary)', async () => {
		const start = 1_000_000_000_000;
		const token = await mintAiSessionToken(SECRET, CLAIMS, {
			ttlSeconds: Seconds.of(60),
			now: () => start,
		});
		// now (in seconds) === exp: the token expires strictly after this instant.
		const atExpiry = () => start + 60_000;
		expect(await verifyAiSessionToken(SECRET, token, atExpiry)).toEqual(CLAIMS);
	});
});
