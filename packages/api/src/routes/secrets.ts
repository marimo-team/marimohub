import { createRoute, z } from '@hono/zod-openapi';
import { assertValidSecretName, NotFoundError } from '@marimo-hub/core';
import type { SecretEntryMeta, SecretInput, SecretsProvider } from '@marimo-hub/core';
import {
	assertProjectRole,
	commonErrors,
	createApp,
	errorResponses,
	jsonBody,
	jsonContent,
	ProjectIdParam,
	SuccessResponseSchema,
} from '../shared';
import type { ApiDeps } from '../shared';

// The env var name lives in the path; it is validated in the handler via
// `assertValidSecretName` (→ 422) so the reserved-name rules stay in one place.
const SecretNameParam = ProjectIdParam.extend({
	name: z.string().openapi({ param: { name: 'name', in: 'path' }, example: 'OPENAI_API_KEY' }),
});

const SecretRefResponseSchema = z.object({
	backend: z.string().openapi({ example: 'aws-sm' }),
	locator: z.string().openapi({ example: 'prod/ai#OPENAI_API_KEY' }),
	/** When 'json', the secret is a JSON object fanned out into one env var per key. */
	expand: z.literal('json').optional(),
	prefix: z.string().optional(),
});

// A managed value is NEVER serialized here — only names, kinds, and (for
// references) the non-sensitive locator.
const SecretEntryResponseSchema = z
	.object({
		name: z.string(),
		kind: z.enum(['managed', 'reference']),
		ref: SecretRefResponseSchema.optional(),
		created_by: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.openapi('SecretEntry');

const SecretPutBody = z
	.discriminatedUnion('kind', [
		z.object({ kind: z.literal('managed'), value: z.string().min(1) }),
		z.object({
			kind: z.literal('reference'),
			backend: z.string().min(1).openapi({ example: 'aws-sm' }),
			locator: z.string().min(1).openapi({ example: 'prod/ai#OPENAI_API_KEY' }),
			/** Fan a JSON-object secret out into one env var per key. */
			expand: z.literal('json').optional(),
			prefix: z.string().optional(),
		}),
	])
	.openapi('SecretInput');

const SecretValidateResponseSchema = z
	.object({
		ok: z.boolean(),
		/** Non-leaking failure reason when `ok` is false (never the value/locator). */
		reason: z.string().optional(),
	})
	.openapi('SecretValidateResult');

type SecretPutBodyType = z.infer<typeof SecretPutBody>;

const listSecrets = createRoute({
	method: 'get',
	path: '/projects/{pid}/secrets',
	tags: ['Secrets'],
	summary: "List a project's secrets (metadata only — never a value)",
	request: { params: ProjectIdParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: z.array(SecretEntryResponseSchema) }),
			'Secret entries (names, kinds, reference locators)',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const putSecret = createRoute({
	method: 'put',
	path: '/projects/{pid}/secrets/{name}',
	tags: ['Secrets'],
	summary: 'Create or overwrite a project secret (admin only)',
	request: { params: SecretNameParam, body: jsonBody(SecretPutBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SecretEntryResponseSchema }),
			'Secret created or overwritten',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const deleteSecret = createRoute({
	method: 'delete',
	path: '/projects/{pid}/secrets/{name}',
	tags: ['Secrets'],
	summary: 'Delete a project secret (admin only)',
	request: { params: SecretNameParam },
	responses: {
		200: jsonContent(SuccessResponseSchema, 'Secret deleted'),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

const validateSecret = createRoute({
	method: 'post',
	path: '/projects/{pid}/secrets/validate',
	tags: ['Secrets'],
	summary: 'Test that a reference resolves, without saving it (admin only)',
	description:
		'Dry-run: attempts to resolve the reference so a broken locator surfaces before ' +
		'it fails a session closed. Never returns the value — only ok/reason.',
	request: { params: ProjectIdParam, body: jsonBody(SecretPutBody) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SecretValidateResponseSchema }),
			'Whether the input resolves',
		),
		...commonErrors(),
		...errorResponses(403, 404),
	},
});

/** 404 when the deployment has secrets disabled (no provider wired). */
function requireSecrets(deps: ApiDeps): SecretsProvider {
	if (!deps.secrets) throw new NotFoundError('Project secrets are not enabled on this deployment');
	return deps.secrets;
}

/** Map the discriminated request body to the domain SecretInput. */
function toSecretInput(body: SecretPutBodyType): SecretInput {
	return body.kind === 'managed'
		? { kind: 'managed', value: body.value }
		: {
				kind: 'reference',
				ref: {
					backend: body.backend,
					locator: body.locator,
					...(body.expand ? { expand: body.expand } : {}),
					...(body.prefix ? { prefix: body.prefix } : {}),
				},
			};
}

function entryResponse(e: SecretEntryMeta) {
	return {
		name: e.name,
		kind: e.kind,
		ref: e.ref,
		created_by: e.created_by,
		created_at: e.created_at,
		updated_at: e.updated_at,
	};
}

const app = createApp();

app.openapi(listSecrets, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const secrets = requireSecrets(deps);
	await assertProjectRole(deps.services.projects, pid, user.id, 'viewer', deps.policy.defaultRole);
	const data = (await secrets.list(pid)).map(entryResponse);
	return c.json({ success: true, data }, 200);
});

app.openapi(putSecret, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, name } = c.req.valid('param');
	const secrets = requireSecrets(deps);
	await assertProjectRole(deps.services.projects, pid, user.id, 'admin', deps.policy.defaultRole);
	assertValidSecretName(name);
	const input = toSecretInput(c.req.valid('json'));
	const entry = await secrets.put(pid, name, input, user.id);
	// Audit trail: record the mutation (name/kind/backend only — never the value or
	// locator secret material). Best-effort; never fail the write on an audit hiccup.
	await deps.services.events
		.append({
			event: 'secret.put',
			actor: user.id,
			project_id: pid,
			secret_name: name,
			secret_kind: entry.kind,
			...(entry.ref ? { secret_backend: entry.ref.backend } : {}),
		})
		.catch(() => {});
	return c.json({ success: true, data: entryResponse(entry) }, 200);
});

app.openapi(deleteSecret, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid, name } = c.req.valid('param');
	const secrets = requireSecrets(deps);
	await assertProjectRole(deps.services.projects, pid, user.id, 'admin', deps.policy.defaultRole);
	await secrets.delete(pid, name);
	await deps.services.events
		.append({ event: 'secret.delete', actor: user.id, project_id: pid, secret_name: name })
		.catch(() => {});
	return c.json({ success: true }, 200);
});

app.openapi(validateSecret, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const { pid } = c.req.valid('param');
	const secrets = requireSecrets(deps);
	await assertProjectRole(deps.services.projects, pid, user.id, 'admin', deps.policy.defaultRole);
	try {
		await secrets.validate(toSecretInput(c.req.valid('json')));
		return c.json({ success: true as const, data: { ok: true } }, 200);
	} catch (err) {
		// The resolver names the entry, never the value — safe to surface.
		return c.json(
			{ success: true as const, data: { ok: false, reason: (err as Error).message } },
			200,
		);
	}
});

export default app;
