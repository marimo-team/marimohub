/**
 * OpenAI-compatible AI proxy for managed-AI notebooks (`/api/ai/v1`).
 *
 * Notebook kernels run untrusted user code, so they never hold the real upstream
 * provider key — only a short-lived, session-scoped token marimohub mints at
 * provision time (see `marimoAiContributor`). This route verifies that token,
 * then forwards the request to the configured upstream with the real key,
 * streaming the response straight back. It authenticates by the token alone, so
 * it lives OUTSIDE the `/api/v1/*` cookie-auth + CSRF guards.
 *
 * Both `/chat/completions` and `/responses` are forwarded: we inject a custom
 * provider (→ chat completions), but `/responses` is here so a client pointed at
 * the built-in `[ai.open_ai]` provider (which uses the Responses API) still works.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { proxy } from 'hono/proxy';
import { verifyAiSessionToken } from '@marimo-hub/core';
import type { AiTokenClaims } from '@marimo-hub/core';
import type { HonoEnv } from '../context';
import { logEvent } from '../log';

/** The verified token claims, stashed by the bearer-auth middleware for handlers. */
type AiEnv = { Variables: HonoEnv['Variables'] & { aiClaims: AiTokenClaims } };

/** OpenAI-style error body, so marimo's `openai` client surfaces a clean message. */
const aiError = (message: string, type: string) => ({ error: { message, type } });

function openAiError(message: string, type: string, status: number) {
	return Response.json(aiError(message, type), { status });
}

/** Drop the upstream provider's leading prefix marimo prepends from the model id. */
function normalizeModel(model: unknown, provider: string): string | undefined {
	if (typeof model !== 'string') return undefined;
	const prefix = `${provider}/`;
	return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

/**
 * Forward a JSON request body to `<upstream>{path}` with the real key, streaming the
 * response back. Shared by the chat-completions and responses endpoints.
 */
async function forward(c: Context<AiEnv>, path: string): Promise<Response> {
	const ai = c.get('deps').ai!;
	const claims = c.get('aiClaims');

	let payload: Record<string, unknown>;
	try {
		payload = await c.req.json();
	} catch {
		return openAiError('Invalid JSON body', 'invalid_request_error', 400);
	}

	// Force the model to a managed one: strip marimo's provider prefix, then fall
	// back to the configured default when it isn't on the allowlist. Untrusted
	// code can't reach an arbitrary upstream model this way.
	let model = normalizeModel(payload.model, 'marimohub') ?? ai.model;
	if (ai.allowedModels && !ai.allowedModels.includes(model)) model = ai.model;
	payload.model = model;

	try {
		// `proxy` streams the upstream body back and drops hop-by-hop/encoding
		// headers; we pass our own headers so the client's session token is never
		// forwarded and the real upstream key is added server-side.
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			authorization: `Bearer ${ai.upstreamApiKey}`,
		};
		if (ai.upstreamProject) headers['openai-project'] = ai.upstreamProject;
		const res = await proxy(`${ai.upstreamBaseUrl}${path}`, {
			method: 'POST',
			headers,
			body: JSON.stringify(payload),
		});
		logEvent({
			level: 'info',
			event: 'ai_proxy_request',
			path,
			project_id: claims.projectId,
			notebook_id: claims.notebookId,
			session_id: claims.sessionId,
			user_id: claims.userId,
			model,
			status: res.status,
		});
		return res;
	} catch (err) {
		logEvent({
			level: 'error',
			event: 'ai_proxy_upstream_error',
			path,
			project_id: claims.projectId,
			session_id: claims.sessionId,
			model,
			error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
		});
		return openAiError('Upstream AI provider unreachable', 'api_error', 502);
	}
}

export function createAiProxy(): Hono<AiEnv> {
	const app = new Hono<AiEnv>();

	// 404 before auth so an unconfigured deployment reports "not enabled" rather
	// than challenging for a token.
	app.use('*', async (c, next) => {
		if (!c.get('deps').ai) return openAiError('AI is not enabled', 'not_configured', 404);
		return next();
	});

	app.use(
		'*',
		bearerAuth<AiEnv>({
			verifyToken: async (token, c) => {
				const ai = c.get('deps').ai;
				if (!ai) return false;
				const claims = await verifyAiSessionToken(ai.signingSecret, token);
				if (!claims) return false;
				c.set('aiClaims', claims);
				return true;
			},
			noAuthenticationHeader: { message: aiError('Missing bearer token', 'invalid_request_error') },
			invalidAuthenticationHeader: {
				message: aiError('Malformed authorization header', 'invalid_request_error'),
			},
			invalidToken: { message: aiError('Invalid or expired token', 'invalid_request_error') },
		}),
	);

	app.post('/chat/completions', (c) => forward(c, '/chat/completions'));
	app.post('/responses', (c) => forward(c, '/responses'));

	app.get('/models', (c) => {
		const ai = c.get('deps').ai!;
		const ids = ai.allowedModels && ai.allowedModels.length > 0 ? ai.allowedModels : [ai.model];
		const data = ids.map((id) => ({ id, object: 'model', owned_by: 'marimohub' }));
		return Response.json({ object: 'list', data });
	});

	return app;
}
