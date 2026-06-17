import { describe, expect, it } from 'vitest';
import { makeAi } from './ai';
import { ConfigError } from './errors';

const aiEnv = {
	MARIMOHUB_AI_BACKEND: 'openai-compatible',
	MARIMOHUB_AUTH_SESSION_SECRET: 'secret',
	MARIMOHUB_AI_UPSTREAM_BASE_URL: 'https://api.example.com/v1',
	MARIMOHUB_AI_UPSTREAM_API_KEY: 'key',
	MARIMOHUB_AI_MODEL: 'gpt-4o-mini',
};

describe('makeAi', () => {
	it('is disabled when the backend is unset or none', () => {
		expect(makeAi({})).toEqual({});
		expect(makeAi({ MARIMOHUB_AI_BACKEND: 'none' })).toEqual({});
	});

	it('wires the openai-compatible backend with an optional token TTL', () => {
		const { ai } = makeAi({ ...aiEnv, MARIMOHUB_AI_TOKEN_TTL_SECONDS: '900' });
		expect(ai?.tokenTtlSeconds).toBe(900);
	});

	it('leaves the token TTL undefined when unset (mint falls back to its default)', () => {
		expect(makeAi(aiEnv).ai?.tokenTtlSeconds).toBeUndefined();
	});

	it.each(['0', '-1'])(
		'rejects MARIMOHUB_AI_TOKEN_TTL_SECONDS=%s, which would mint already-expired tokens',
		(value) => {
			expect(() => makeAi({ ...aiEnv, MARIMOHUB_AI_TOKEN_TTL_SECONDS: value })).toThrow(
				ConfigError,
			);
		},
	);

	it('does not validate the TTL when the AI backend is disabled', () => {
		expect(makeAi({ MARIMOHUB_AI_TOKEN_TTL_SECONDS: '0' })).toEqual({});
	});
});
