/**
 * Wire the managed-AI proxy from the `MARIMOHUB_AI_BACKEND` selector and its
 * backend vars. All-or-nothing: `none` (default) disables it, `openai-compatible`
 * fronts one OpenAI-compatible upstream. The session-token signing secret is reused
 * from `MARIMOHUB_AUTH_SESSION_SECRET` (like the proxy-exposure routing tokens), so
 * there is no separate AI key to manage.
 */
import type { ApiDeps } from '@marimo-hub/api';
import { Seconds } from '@marimo-hub/core';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { parseIntEnv, parseList, requiredVar } from './env';
import type { Env } from './env';
import { ConfigError } from './errors';

const DOCS = 'docs/ai.md';

export function makeAi(env: Env): Pick<ApiDeps, 'ai'> {
	const backend = env.MARIMOHUB_AI_BACKEND?.trim().toLowerCase();
	if (backend === undefined || backend === '' || backend === 'none') return {};
	if (backend !== 'openai-compatible') {
		throw new ConfigError(
			`Unknown MARIMOHUB_AI_BACKEND: ${env.MARIMOHUB_AI_BACKEND} (supported: openai-compatible, none).`,
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
	const upstreamBaseUrl = requiredVar(env, 'MARIMOHUB_AI_UPSTREAM_BASE_URL', {
		remediation: 'Set the upstream OpenAI-compatible base URL, e.g. https://api.openai.com/v1',
		docs: DOCS,
	}).replace(/\/+$/, '');
	const upstreamApiKey = requiredVar(env, 'MARIMOHUB_AI_UPSTREAM_API_KEY', {
		remediation: 'Set the upstream provider API key (held server-side, never injected).',
		docs: DOCS,
	});
	const model = requiredVar(env, 'MARIMOHUB_AI_MODEL', {
		remediation: 'Set the default upstream model id, e.g. gpt-4o-mini',
		docs: DOCS,
	});
	const upstreamProject = env.MARIMOHUB_AI_UPSTREAM_PROJECT;
	const provider = createOpenAICompatible({
		name: 'marimohub-managed-ai',
		baseURL: upstreamBaseUrl,
		apiKey: upstreamApiKey,
		headers: upstreamProject ? { 'OpenAI-Project': upstreamProject } : undefined,
	});
	const maxTokens = parseIntEnv(env, 'MARIMOHUB_AI_MAX_TOKENS');
	return {
		ai: {
			upstreamBaseUrl,
			upstreamApiKey,
			upstreamProject,
			model,
			signingSecret,
			allowedModels: parseList(env.MARIMOHUB_AI_ALLOWED_MODELS),
			maxTokens,
			rules: env.MARIMOHUB_AI_RULES,
			tokenTtlSeconds: tokenTtl === undefined ? undefined : Seconds.of(tokenTtl),
			async generateSql(input) {
				const result = await generateText({
					model: provider.chatModel(model),
					instructions:
						`You generate DuckDB SQL. Return SQL only, without Markdown fences or explanation. ` +
						`Use only the supplied schema and write read-only statements.${
							env.MARIMOHUB_AI_RULES ? `\n${env.MARIMOHUB_AI_RULES}` : ''
						}`,
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
