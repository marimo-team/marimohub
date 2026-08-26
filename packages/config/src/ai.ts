/**
 * Wire the managed-AI proxy from the `MARIMOHUB_AI_BACKEND` selector and its
 * backend vars. All-or-nothing: `none` (default) disables it; enabled backends
 * front one OpenAI-compatible upstream. The session-token signing secret is reused
 * from `MARIMOHUB_AUTH_SESSION_SECRET` (like the proxy-exposure routing tokens), so
 * there is no separate AI key to manage.
 */
import type { ApiDeps } from '@marimo-hub/api';
import { Seconds } from '@marimo-hub/core';
import { createAwsSigV4Fetch } from '@marimo-hub/credentials-aws';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { parseIntEnv, parseList, requiredVar } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

const DOCS = 'docs/ai.md';

export function sqlGenerationInstructions(
	dialect: 'duckdb' | 'postgresql',
	rules?: string,
): string {
	return (
		`You generate ${dialect === 'postgresql' ? 'PostgreSQL' : 'DuckDB'} SQL. ` +
		`Return SQL only, without Markdown fences or explanation. ` +
		`Use only the supplied schema and write read-only statements.${rules ? `\n${rules}` : ''}`
	);
}

function bedrockRegion(env: Env): string {
	const region = env.MARIMOHUB_AI_AWS_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
	if (region) return region;
	throw new ConfigError(
		'Missing required env var: MARIMOHUB_AI_AWS_REGION (AWS_REGION and AWS_DEFAULT_REGION are also accepted)',
		{
			variable: 'MARIMOHUB_AI_AWS_REGION',
			remediation: 'Set the AWS region that hosts the Bedrock models, e.g. eu-west-1.',
			docs: DOCS,
		},
	);
}

export function makeAi(env: Env): Pick<ApiDeps, 'ai'> {
	const backend = env.MARIMOHUB_AI_BACKEND?.trim().toLowerCase();
	if (backend === undefined || backend === '' || backend === 'none') return {};
	if (backend !== 'openai-compatible' && backend !== 'bedrock') {
		throw new ConfigError(
			`Unknown MARIMOHUB_AI_BACKEND: ${env.MARIMOHUB_AI_BACKEND} (supported: bedrock, openai-compatible, none).`,
			{ variable: 'MARIMOHUB_AI_BACKEND', docs: DOCS },
		);
	}

	const signingSecret = env.MARIMOHUB_AUTH_SESSION_SECRET;
	if (!signingSecret) {
		throw new ConfigError(
			'MARIMOHUB_AI_BACKEND is set but MARIMOHUB_AUTH_SESSION_SECRET is unset; the AI proxy ' +
				'signs its per-session tokens with it.',
			{
				variable: 'MARIMOHUB_AUTH_SESSION_SECRET',
				remediation: 'Set MARIMOHUB_AUTH_SESSION_SECRET (also used to sign session cookies).',
				docs: DOCS,
			},
		);
	}

	const tokenTtl = parseIntEnv(env, 'MARIMOHUB_AI_TOKEN_TTL_SECONDS');
	if (tokenTtl !== undefined && tokenTtl < 1) {
		throw new ConfigError(
			`Invalid MARIMOHUB_AI_TOKEN_TTL_SECONDS: ${tokenTtl} (expected an integer >= 1); ` +
				'a non-positive TTL mints already-expired session tokens, so every AI request fails.',
			{
				variable: 'MARIMOHUB_AI_TOKEN_TTL_SECONDS',
				remediation: 'Set a positive number of seconds, or unset it to use the 1-hour default.',
				docs: DOCS,
			},
		);
	}
	const awsRegion = backend === 'bedrock' ? bedrockRegion(env) : undefined;
	const upstreamBaseUrl =
		awsRegion !== undefined
			? `https://bedrock-runtime.${awsRegion}.amazonaws.com/v1`
			: requiredVar(env, 'MARIMOHUB_AI_UPSTREAM_BASE_URL', {
					remediation:
						'Set the upstream OpenAI-compatible base URL, e.g. https://api.openai.com/v1',
					docs: DOCS,
				}).replace(/\/+$/, '');
	const upstreamApiKey =
		backend === 'openai-compatible'
			? requiredVar(env, 'MARIMOHUB_AI_UPSTREAM_API_KEY', {
					remediation: 'Set the upstream provider API key (held server-side, never injected).',
					docs: DOCS,
				})
			: undefined;
	const upstreamFetch =
		awsRegion !== undefined
			? createAwsSigV4Fetch({ region: awsRegion, service: 'bedrock' })
			: undefined;
	const model = requiredVar(env, 'MARIMOHUB_AI_MODEL', {
		remediation: 'Set the default upstream model id, e.g. gpt-4o-mini',
		docs: DOCS,
	});
	const upstreamProject =
		backend === 'openai-compatible' ? env.MARIMOHUB_AI_UPSTREAM_PROJECT : undefined;
	const provider = createOpenAICompatible({
		name: 'marimohub-managed-ai',
		baseURL: upstreamBaseUrl,
		apiKey: upstreamApiKey,
		headers: upstreamProject ? { 'OpenAI-Project': upstreamProject } : undefined,
		fetch: upstreamFetch,
	});
	const maxTokens = parseIntEnv(env, 'MARIMOHUB_AI_MAX_TOKENS');
	if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
		throw new ConfigError(
			`Invalid MARIMOHUB_AI_MAX_TOKENS: ${maxTokens} (expected a positive safe integer)`,
			{ variable: 'MARIMOHUB_AI_MAX_TOKENS', docs: DOCS },
		);
	}
	return {
		ai: {
			upstreamBaseUrl,
			upstreamApiKey,
			upstreamProject,
			upstreamFetch,
			model,
			signingSecret,
			allowedModels:
				parseList(env.MARIMOHUB_AI_ALLOWED_MODELS) ?? (backend === 'bedrock' ? [model] : undefined),
			maxTokens,
			rules: env.MARIMOHUB_AI_RULES,
			tokenTtlSeconds: tokenTtl === undefined ? undefined : Seconds.of(tokenTtl),
			async generateSql(input) {
				const result = await generateText({
					model: provider.chatModel(model),
					instructions: sqlGenerationInstructions(input.dialect, env.MARIMOHUB_AI_RULES),
					prompt: [
						`Mode: ${input.mode}`,
						`Instruction: ${input.instruction}`,
						input.sql ? `Current SQL:\n${input.sql}` : '',
						`Schema:\n${input.schema}`,
					]
						.filter(Boolean)
						.join('\n\n'),
					abortSignal: input.signal,
					...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
				});
				return result.text;
			},
		},
	};
}
