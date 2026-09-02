import { createRoute, z } from '@hono/zod-openapi';
import {
	DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS,
	isSuperAdmin,
	MAX_REQUEST_BYTES,
	MAX_QUEUED_RUNS_PER_JOB,
	MAX_VERSIONS,
	Millis,
	PROJECT_ALERT_KINDS,
	viewerSessionModes,
} from '@marimo-hub/core';
import {
	canDeploymentAction,
	CapabilitiesResponseSchema,
	createApp,
	DeploymentInfoResponseSchema,
	errorResponses,
	jsonContent,
	MeResponseSchema,
	ok,
	toComputeResourcesResponse,
	subjectDefaultRole,
} from '../shared';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../pagination';
import { surfaceCapabilities } from './sessionSurfaces';

/**
 * System routes: current user (`/api/v1/me`), deployment metadata (`/api/v1/version`),
 * and capability flags (`/api/v1/capabilities`). `version`/`capabilities` skip the
 * auto-init guard (they render before any catalog exists) and expose no secret.
 */
const app = createApp();

const meRoute = createRoute({
	method: 'get',
	path: '/me',
	operationId: 'me',
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

app.openapi(meRoute, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	const logoutUrl = deps.authenticator.logoutUrl?.() ?? null;
	return ok(c, {
		id: user.id,
		email: user.email,
		name: user.name ?? null,
		picture_url: user.pictureUrl ?? null,
		logout_url: logoutUrl,
		is_super_admin: isSuperAdmin(user, deps.policy.superAdmins),
		can_create_projects: await canDeploymentAction(user, 'project.create', deps),
	});
});

const versionRoute = createRoute({
	method: 'get',
	path: '/version',
	operationId: 'version',
	tags: ['System'],
	summary: 'Get the deployment version',
	description:
		'Just the version string. The rest of the build/runtime identity (image, replica, ' +
		'backends, …) is super-admin material on `GET /api/v1/admin/config`.',
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
	return ok(c, { version: v?.version ?? 'dev' });
});

const capabilitiesRoute = createRoute({
	method: 'get',
	path: '/capabilities',
	operationId: 'capabilities',
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
		integrations: { available: Boolean(deps.integrations) },
		source_control: {
			change_request_providers: [...(deps.sourceControl?.publisherProviders() ?? [])],
			sync_providers: [...(deps.sourceControl?.readerProviders() ?? [])],
			pull_source_providers: [...(deps.sourceControl?.pullSourceProviders() ?? [])],
		},
		project_alerts: {
			available: Boolean(deps.projectAlerts),
			destination_types: deps.projectAlerts
				? (['slack', 'webhook'] satisfies ('slack' | 'webhook')[])
				: [],
			selectable_kinds: deps.projectAlerts
				? PROJECT_ALERT_KINDS.filter((kind) => deps.jobs || !kind.startsWith('job.'))
				: [],
			max_destinations: deps.projectAlerts?.maxDestinations ?? 10,
		},
		jobs: deps.jobs
			? {
					available: true,
					max_per_notebook: deps.jobs.maxPerNotebook ?? null,
					max_queued_runs_per_job: MAX_QUEUED_RUNS_PER_JOB,
					default_timeout_seconds: Millis.toSeconds(deps.jobs.defaultTimeoutMs),
					max_timeout_seconds: Millis.toSeconds(deps.jobs.maxTimeoutMs),
					run_retention_days: deps.jobs.runRetentionMs / Millis.days(1),
				}
			: {
					available: false,
					max_per_notebook: null,
					max_queued_runs_per_job: null,
					default_timeout_seconds: null,
					max_timeout_seconds: null,
					run_retention_days: null,
				},
		data_browser: {
			available: Boolean(deps.dataBrowser),
			preview: deps.dataBrowser?.preview ?? false,
			query: deps.dataBrowser?.query ?? false,
			ai_query: Boolean(deps.dataBrowser?.query && deps.ai?.generateSql),
		},
		// createApi defaults this; the fallback satisfies the optional type for
		// direct callers (mirrors the sandbox.exposure pattern).
		viewer_mode: deps.policy.viewerMode ?? 'static',
		viewer_session_modes: [...viewerSessionModes(deps.policy.viewerMode)],
		editor_sandbox_sharing: deps.policy.editorSandboxSharing ?? 'shared',
		default_role: subjectDefaultRole(c.get('user'), deps.policy),
		limits: {
			max_concurrent_sessions_per_user: deps.policy.maxConcurrentSessionsPerUser ?? null,
			max_apps_per_project: deps.policy.maxAppsPerProject ?? null,
			max_request_bytes: MAX_REQUEST_BYTES,
			max_versions_per_notebook: MAX_VERSIONS,
			default_page_size: DEFAULT_PAGE_SIZE,
			max_page_size: MAX_PAGE_SIZE,
		},
		sandbox_images: deps.sandbox.images ?? [],
		sandbox_startup_timeout_seconds: Millis.toSeconds(
			deps.sandbox.startupTimeoutMs ?? DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS,
		),
		compute_profiles: (deps.sandbox.computeProfiles ?? []).map((profile) => ({
			name: profile.name,
			...toComputeResourcesResponse(profile.resources),
		})),
		compute_profile_override: deps.sandbox.computeProfileOverride ?? 'none',
		surfaces: surfaceCapabilities(deps),
	});
});

export default app;
