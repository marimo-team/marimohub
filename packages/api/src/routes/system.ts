import { createRoute, z } from '@hono/zod-openapi';
import { MAX_REQUEST_BYTES, MAX_VERSIONS, viewerSessionModes } from '@marimo-hub/core';
import {
	CapabilitiesResponseSchema,
	createApp,
	DeploymentInfoResponseSchema,
	errorResponses,
	jsonContent,
	MeResponseSchema,
	ok,
} from '../shared';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../pagination';

/**
 * System routes: current user (`/api/v1/me`), deployment metadata (`/api/v1/version`),
 * and capability flags (`/api/v1/capabilities`). `version`/`capabilities` skip the
 * auto-init guard (they render before any catalog exists) and expose no secret.
 */
const app = createApp();

const meRoute = createRoute({
	method: 'get',
	path: '/me',
	tags: ['Auth'],
	summary: 'Get current user info',
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: MeResponseSchema }),
			'Current user information',
		),
		...errorResponses(401),
	},
});

app.openapi(meRoute, (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const logoutUrl = deps.authenticator.logoutUrl?.() ?? null;
	return ok(c, { id: user.id, email: user.email, logout_url: logoutUrl });
});

const versionRoute = createRoute({
	method: 'get',
	path: '/version',
	tags: ['System'],
	summary: 'Get deployment version info',
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: DeploymentInfoResponseSchema }),
			'Deployment version information',
		),
		...errorResponses(401),
	},
});

app.openapi(versionRoute, (c) => {
	const v = c.get('deps').version;
	return ok(c, {
		version: v?.version ?? 'dev',
		image: v?.image ?? null,
		sandbox_image: v?.sandboxImage ?? null,
		started_at: v?.startedAt ?? null,
		replica: v?.replica ?? null,
		node: v?.node ?? null,
		backends: v?.backends ?? { storage: 'unknown', compute: 'unknown', auth: 'unknown' },
	});
});

const capabilitiesRoute = createRoute({
	method: 'get',
	path: '/capabilities',
	tags: ['System'],
	summary: 'Get deployment capability flags',
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: CapabilitiesResponseSchema }),
			'Deployment capability flags',
		),
		...errorResponses(401),
	},
});

app.openapi(capabilitiesRoute, (c) => {
	const deps = c.get('deps');
	return ok(c, {
		federation: { available: Boolean(deps.wif) },
		// createApi defaults this; the fallback satisfies the optional type for
		// direct callers (mirrors the sandbox.exposure pattern).
		viewer_mode: deps.policy.viewerMode ?? 'static',
		viewer_session_modes: [...viewerSessionModes(deps.policy.viewerMode)],
		default_role: deps.policy.defaultRole ?? null,
		limits: {
			max_concurrent_sessions_per_user: deps.policy.maxConcurrentSessionsPerUser ?? null,
			max_apps_per_project: deps.policy.maxAppsPerProject ?? null,
			max_request_bytes: MAX_REQUEST_BYTES,
			max_versions_per_notebook: MAX_VERSIONS,
			default_page_size: DEFAULT_PAGE_SIZE,
			max_page_size: MAX_PAGE_SIZE,
		},
		sandbox_images: deps.sandbox.images ?? [],
	});
});

export default app;
