import { describe, expect, it } from 'vitest';
import { makeAi, sqlGenerationInstructions } from './ai';
import { ConfigError } from './errors';

const aiEnv = {
	MARIMOHUB_AI_BACKEND: 'openai-compatible',
	MARIMOHUB_AUTH_SESSION_SECRET: 'secret',
	MARIMOHUB_AI_UPSTREAM_BASE_URL: 'https://api.example.com/v1',
	MARIMOHUB_AI_UPSTREAM_API_KEY: 'key',
	MARIMOHUB_AI_MODEL: 'gpt-4o-mini',
};

describe('makeAi', () => {
	it('selects SQL generation instructions from the advertised dialect', () => {
		expect(sqlGenerationInstructions('duckdb')).toContain('generate DuckDB SQL');
		expect(sqlGenerationInstructions('postgresql', 'Avoid private tables.')).toBe(
			'You generate PostgreSQL SQL. Return SQL only, without Markdown fences or explanation. ' +
				'Use only the supplied schema and write read-only statements.\nAvoid private tables.',
		);
	});

	it('is disabled when the backend is unset or none', () => {
		expect(makeAi({})).toEqual({});
		expect(makeAi({ MARIMOHUB_AI_BACKEND: 'none' })).toEqual({});
	});

	it('wires the openai-compatible backend with an optional token TTL', () => {
		const { ai } = makeAi({ ...aiEnv, MARIMOHUB_AI_TOKEN_TTL_SECONDS: '900' });
		expect(ai?.tokenTtlSeconds).toBe(900);
	});

	it('wires Bedrock through its regional OpenAI-compatible endpoint without an API key', () => {
		const { ai } = makeAi({
			MARIMOHUB_AI_BACKEND: 'bedrock',
			MARIMOHUB_AUTH_SESSION_SECRET: 'secret',
			MARIMOHUB_AI_AWS_REGION: 'eu-west-1',
			MARIMOHUB_AI_MODEL: 'eu.anthropic.claude-opus-4-7',
		});

		expect(ai).toMatchObject({
			upstreamBaseUrl: 'https://bedrock-runtime.eu-west-1.amazonaws.com/v1',
			upstreamApiKey: undefined,
			allowedModels: ['eu.anthropic.claude-opus-4-7'],
		});
		expect(ai?.upstreamFetch).toBeTypeOf('function');
	});

	it('accepts AWS_REGION for the Bedrock region', () => {
		const { ai } = makeAi({
			MARIMOHUB_AI_BACKEND: 'bedrock',
			MARIMOHUB_AUTH_SESSION_SECRET: 'secret',
			AWS_REGION: 'us-east-1',
			MARIMOHUB_AI_MODEL: 'model',
		});
		expect(ai?.upstreamBaseUrl).toContain('bedrock-runtime.us-east-1.amazonaws.com');
	});

	it('requires a region for Bedrock', () => {
		expect(() =>
			makeAi({
				MARIMOHUB_AI_BACKEND: 'bedrock',
				MARIMOHUB_AUTH_SESSION_SECRET: 'secret',
				MARIMOHUB_AI_MODEL: 'model',
			}),
		).toThrow(/MARIMOHUB_AI_AWS_REGION/);
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

	it('throws when the backend is enabled but MARIMOHUB_AUTH_SESSION_SECRET is unset', () => {
		const { MARIMOHUB_AUTH_SESSION_SECRET: _omit, ...env } = aiEnv;
		expect(() => makeAi(env)).toThrow(/MARIMOHUB_AUTH_SESSION_SECRET/);
	});

	it('rejects an unknown MARIMOHUB_AI_BACKEND', () => {
		expect(() => makeAi({ ...aiEnv, MARIMOHUB_AI_BACKEND: 'anthropic' })).toThrow(
			/Unknown MARIMOHUB_AI_BACKEND/,
		);
	});

	it.each([
		'MARIMOHUB_AI_UPSTREAM_BASE_URL',
		'MARIMOHUB_AI_UPSTREAM_API_KEY',
		'MARIMOHUB_AI_MODEL',
	])('requires %s', (key) => {
		const env: Record<string, string | undefined> = { ...aiEnv };
		delete env[key];
		expect(() => makeAi(env)).toThrow(new RegExp(key));
	});

	it('rejects a non-integer MARIMOHUB_AI_MAX_TOKENS', () => {
		expect(() => makeAi({ ...aiEnv, MARIMOHUB_AI_MAX_TOKENS: '1.5' })).toThrow(
			/MARIMOHUB_AI_MAX_TOKENS/,
		);
	});

	it.each(['0', '-1', '9007199254740992'])(
		'rejects invalid MARIMOHUB_AI_MAX_TOKENS=%s',
		(value) => {
			expect(() => makeAi({ ...aiEnv, MARIMOHUB_AI_MAX_TOKENS: value })).toThrow(
				/MARIMOHUB_AI_MAX_TOKENS/,
			);
		},
	);

	it('ignores stale token limits when managed AI is disabled', () => {
		expect(makeAi({ MARIMOHUB_AI_MAX_TOKENS: '-1' })).toEqual({});
	});
});
