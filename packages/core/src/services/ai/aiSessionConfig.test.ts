import { describe, expect, it } from 'vitest';
import { Seconds } from '../../duration';
import {
	aiConfigToSessionEnv,
	buildMarimoAiToml,
	MARIMOHUB_AI_PROVIDER,
	mintAiSessionToken,
	verifyAiSessionToken,
} from './aiSessionConfig';
import type { AiTokenClaims } from './aiSessionConfig';

const SECRET = 'test-session-secret';
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
		expect(toml).toContain('api_key = "a\\"b\\\\c"');
		expect(toml).toContain('rules = "be \\"concise\\""');
	});

	it('omits optional fields when absent', () => {
		const toml = buildMarimoAiToml({ baseUrl: 'u', apiKey: 'k', model: 'm' });
		expect(toml).not.toContain('max_tokens');
		expect(toml).not.toContain('rules');
	});
});

describe('aiConfigToSessionEnv', () => {
	it('writes marimo.toml under XDG_CONFIG_HOME outside the mount path', () => {
		const env = aiConfigToSessionEnv(
			{ baseUrl: 'u', apiKey: 'k', model: 'm' },
			'/opt/marimohub-config/',
		);
		expect(env.vars.XDG_CONFIG_HOME).toBe('/opt/marimohub-config');
		expect(env.files).toHaveLength(1);
		expect(env.files[0].path).toBe('/opt/marimohub-config/marimo/marimo.toml');
		expect(env.files[0].content).toContain('[ai.models]');
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
});
