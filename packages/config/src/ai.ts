/**
 * Wire the managed-AI proxy from the `MARIMOHUB_AI_BACKEND` selector and its
 * backend vars. All-or-nothing: `none` (default) disables it, `openai-compatible`
 * fronts one OpenAI-compatible upstream. The session-token signing secret is reused
 * from `MARIMOHUB_AUTH_SESSION_SECRET` (like the proxy-exposure routing tokens), so
 * there is no separate AI key to manage.
 */
import type { ApiDeps } from '@marimo-hub/api';
import { Seconds } from '@marimo-hub/core';
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
	return {
		ai: {
			// Strip a trailing slash so the proxy's `<base>/chat/completions` join is clean.
			upstreamBaseUrl: requiredVar(env, 'MARIMOHUB_AI_UPSTREAM_BASE_URL', {
				remediation: 'Set the upstream OpenAI-compatible base URL, e.g. https://api.openai.com/v1',
				docs: DOCS,
			}).replace(/\/+$/, ''),
			upstreamApiKey: requiredVar(env, 'MARIMOHUB_AI_UPSTREAM_API_KEY', {
				remediation: 'Set the upstream provider API key (held server-side, never injected).',
				docs: DOCS,
			}),
			upstreamProject: env.MARIMOHUB_AI_UPSTREAM_PROJECT,
			model: requiredVar(env, 'MARIMOHUB_AI_MODEL', {
				remediation: 'Set the default upstream model id, e.g. gpt-4o-mini',
				docs: DOCS,
			}),
			signingSecret,
			allowedModels: parseList(env.MARIMOHUB_AI_ALLOWED_MODELS),
			maxTokens: parseIntEnv(env, 'MARIMOHUB_AI_MAX_TOKENS'),
			rules: env.MARIMOHUB_AI_RULES,
			tokenTtlSeconds: tokenTtl === undefined ? undefined : Seconds.of(tokenTtl),
		},
	};
}
