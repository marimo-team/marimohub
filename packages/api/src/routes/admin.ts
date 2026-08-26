import { createRoute, z } from '@hono/zod-openapi';
import {
	BadRequestError,
	createSandboxId,
	DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS,
	ForbiddenError,
	isSuperAdmin,
	ResourceExhaustedError,
	SandboxDiagnosticLease,
	UserId,
} from '@marimo-hub/core';
import type { ComputeResources, Identity, SandboxInstance } from '@marimo-hub/core';
import {
	AdminUserResponseSchema,
	assertSessionAuthenticated,
	assertSuperAdmin,
	commonErrors,
	ComputeResourcesResponseSchema,
	createApp,
	DeploymentConfigResponseSchema,
	errorResponses,
	jsonBody,
	jsonContent,
	SESSION_ONLY_SECURITY,
	toComputeResourcesResponse,
} from '../shared';
import { appendAudit, errorMetadataChain, logEvent } from '../log';
import { pageSchema } from '../pagination';

const ECHO_COMMAND = 'echo "Hello"';
const STEADY_STATE_EXEC_TIMEOUT_MS = 30_000;
const CLEANUP_LEASE_HEADROOM_MS = 60_000;

const SandboxStartupPhaseSchema = z
	.object({
		status: z.enum(['ok', 'failed', 'skipped']),
		duration_ms: z.number().nonnegative().nullable(),
		error: z.record(z.string(), z.unknown()).optional(),
	})
	.openapi('SandboxStartupPhase');

const SandboxStartupCommandSchema = SandboxStartupPhaseSchema.extend({
	command: z.string().openapi({ example: ECHO_COMMAND }),
	stdout: z.string(),
	stderr: z.string(),
	failure_code: z.enum(['COMMAND_FAILED', 'SPAWN_FAILED', 'BACKEND_ERROR']).optional(),
}).openapi('SandboxStartupCommand');

const SandboxStartupRequestSchema = z
	.object({
		image: z.string().min(1).optional(),
		compute_profile: z.string().min(1).optional(),
	})
	.strict()
	.openapi('SandboxStartupRequest');

const SandboxStartupReportSchema = z
	.object({
		ok: z.boolean(),
		sandbox_id: z.string(),
		image: z.string().nullable(),
		compute_profile: z.string().nullable(),
		compute_resources: ComputeResourcesResponseSchema,
		started_at: z.iso.datetime(),
		finished_at: z.iso.datetime(),
		total_ms: z.number().nonnegative(),
		handle: SandboxStartupPhaseSchema,
		readiness: SandboxStartupCommandSchema,
		exec: SandboxStartupCommandSchema,
		cleanup: SandboxStartupPhaseSchema,
		startup_timings_ms: z.record(z.string(), z.number().nonnegative()),
		counters: z.record(z.string(), z.number()),
	})
	.openapi('SandboxStartupReport');

type SandboxStartupPhase = z.infer<typeof SandboxStartupPhaseSchema>;
type SandboxStartupCommand = z.infer<typeof SandboxStartupCommandSchema>;
type SandboxStartupReport = z.infer<typeof SandboxStartupReportSchema>;

function elapsed(started: number): number {
	return performance.now() - started;
}

function skippedPhase(): SandboxStartupPhase {
	return { status: 'skipped', duration_ms: null };
}

function skippedCommand(): SandboxStartupCommand {
	return {
		...skippedPhase(),
		command: ECHO_COMMAND,
		stdout: '',
		stderr: '',
	};
}

function failedPhase(started: number, error: unknown): SandboxStartupPhase {
	return {
		status: 'failed',
		duration_ms: elapsed(started),
		error: errorMetadataChain(error),
	};
}

async function runEcho(sandbox: SandboxInstance, timeout: number): Promise<SandboxStartupCommand> {
	const started = performance.now();
	try {
		const result = await sandbox.exec(ECHO_COMMAND, { timeout });
		return result.success
			? {
					status: 'ok',
					duration_ms: elapsed(started),
					command: ECHO_COMMAND,
					stdout: result.stdout,
					stderr: result.stderr,
				}
			: {
					status: 'failed',
					duration_ms: elapsed(started),
					command: ECHO_COMMAND,
					stdout: result.stdout,
					stderr: result.stderr,
					failure_code: result.error.code,
				};
	} catch (error) {
		return {
			...failedPhase(started, error),
			command: ECHO_COMMAND,
			stdout: '',
			stderr: '',
		};
	}
}

function selectedImage(
	images: readonly string[],
	requested: string | undefined,
): string | undefined {
	if (requested === undefined) return images[0];
	if (!images.includes(requested)) {
		throw new BadRequestError(
			images.length > 0
				? `Unknown sandbox image "${requested}"; valid options: ${images.join(', ')}`
				: 'This deployment does not offer sandbox image selection',
		);
	}
	return requested;
}

function selectedComputeProfile(
	profiles: readonly { name: string; resources: ComputeResources }[],
	fallbackName: string | undefined,
	fallbackResources: ComputeResources | undefined,
	requested: string | undefined,
): { name: string | undefined; resources: ComputeResources } {
	const fallback = profiles[0] ?? { name: fallbackName, resources: fallbackResources ?? {} };
	if (requested === undefined) return fallback;
	const selected = profiles.find((profile) => profile.name === requested);
	if (!selected) {
		throw new BadRequestError(
			profiles.length > 0
				? `Unknown compute profile "${requested}"; valid options: ${profiles.map((profile) => profile.name).join(', ')}`
				: 'This deployment does not offer compute profile selection',
		);
	}
	return selected;
}

const UserSuspensionParam = z.object({
	id: z
		.string()
		.min(1)
		.openapi({
			param: { name: 'id', in: 'path', description: "The user's identity-provider subject id" },
			example: 'user_01HXY00000000000000000000',
		}),
});

function adminUser(identity: Identity, superAdmins?: readonly string[]) {
	return {
		id: identity.id,
		email: identity.email,
		name: identity.name,
		updated_at: identity.updated_at,
		suspended_at: identity.suspended_at ?? null,
		is_super_admin: isSuperAdmin(identity, superAdmins),
	};
}

const listUsers = createRoute({
	method: 'get',
	path: '/admin/users',
	operationId: 'admin.users.list',
	tags: ['Admin'],
	summary: 'List all users in the identity directory',
	description:
		'Every user who has signed in at least once, name-sorted. Currently a single page ' +
		'(`next_cursor` is always null). Super-admin only, and session-only: a PAT — even a ' +
		'super admin’s — is rejected with 403.',
	security: SESSION_ONLY_SECURITY,
	responses: {
		200: jsonContent(
			z.object({
				success: z.literal(true),
				data: pageSchema(AdminUserResponseSchema, 'AdminUserPage'),
			}),
			'The user directory, name-sorted',
		),
		...commonErrors(),
		...errorResponses(403),
	},
});

const getConfig = createRoute({
	method: 'get',
	path: '/admin/config',
	operationId: 'admin.config.get',
	tags: ['Admin'],
	summary: "Describe the deployment's configuration",
	description:
		'Read-only view of every configuration group (storage, compute, auth, …) as resolved from ' +
		"the serving replica's environment at boot; secret values are never included, only whether " +
		'they are set. Super-admin only, session-only.',
	security: SESSION_ONLY_SECURITY,
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: DeploymentConfigResponseSchema }),
			'The deployment configuration, secrets redacted',
		),
		...commonErrors(),
		...errorResponses(403),
	},
});

const testSandboxStartup = createRoute({
	method: 'post',
	path: '/admin/debug/sandbox-startup',
	operationId: 'admin.debug.sandboxStartup',
	'x-cli-hidden': true,
	tags: ['Admin'],
	summary: 'Measure sandbox startup and command latency',
	description:
		'Creates a fresh ephemeral sandbox, uses the first fixed echo command as the readiness ' +
		'probe, measures a second fixed echo command, and destroys the sandbox. Runtime failures ' +
		'are returned as a partial report. Super-admin only and session-only.',
	security: SESSION_ONLY_SECURITY,
	request: { body: jsonBody(SandboxStartupRequestSchema) },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: SandboxStartupReportSchema }),
			'The sandbox startup diagnostic report',
		),
		...commonErrors(),
		...errorResponses(400, 403, 429),
	},
});

const suspendUser = createRoute({
	method: 'put',
	path: '/admin/users/{id}/suspension',
	operationId: 'admin.users.suspend',
	'x-cli-destructive': true,
	tags: ['Users', 'Admin'],
	summary: 'Suspend a user',
	description:
		'Blocks the user at authentication time, including personal access tokens. Super-admin ' +
		'only and session-only. A super admin cannot suspend their own account.',
	security: SESSION_ONLY_SECURITY,
	request: { params: UserSuspensionParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: AdminUserResponseSchema }),
			'The suspended user',
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const unsuspendUser = createRoute({
	method: 'delete',
	path: '/admin/users/{id}/suspension',
	operationId: 'admin.users.unsuspend',
	tags: ['Users', 'Admin'],
	summary: 'Reactivate a suspended user',
	description: 'Restores authentication for a known user. Super-admin only and session-only.',
	security: SESSION_ONLY_SECURITY,
	request: { params: UserSuspensionParam },
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: AdminUserResponseSchema }),
			'The reactivated user',
		),
		...commonErrors(),
		...errorResponses(404),
	},
});

const app = createApp();

app.openapi(listUsers, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	assertSessionAuthenticated(c, 'access admin endpoints');
	assertSuperAdmin(user, deps.policy);

	const all = await deps.services.identities.list();
	const items = all
		.map((identity) => adminUser(identity, deps.policy.superAdmins))
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	// The directory is served whole (same O(low-thousands) bound as user
	// search); the page envelope reserves room for a real cursor later.
	return c.json({ success: true, data: { items, next_cursor: null } }, 200);
});

app.openapi(suspendUser, async (c) => {
	const deps = c.get('deps');
	const actor = c.get('user');
	assertSessionAuthenticated(c, 'suspend users');
	assertSuperAdmin(actor, deps.policy);
	const targetId = UserId.parse(c.req.valid('param').id);
	if (targetId === actor.id) throw new ForbiddenError('You cannot suspend your own account');

	const identity = await deps.services.identities.setSuspension(targetId, true);
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: actor.id },
		'user.suspended',
		() =>
			deps.services.events.append({
				event: 'user.suspended',
				actor: actor.id,
				target_user_id: targetId,
			}),
	);
	return c.json({ success: true, data: adminUser(identity, deps.policy.superAdmins) }, 200);
});

app.openapi(unsuspendUser, async (c) => {
	const deps = c.get('deps');
	const actor = c.get('user');
	assertSessionAuthenticated(c, 'reactivate users');
	assertSuperAdmin(actor, deps.policy);
	const targetId = UserId.parse(c.req.valid('param').id);

	const identity = await deps.services.identities.setSuspension(targetId, false);
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: actor.id },
		'user.unsuspended',
		() =>
			deps.services.events.append({
				event: 'user.unsuspended',
				actor: actor.id,
				target_user_id: targetId,
			}),
	);
	return c.json({ success: true, data: adminUser(identity, deps.policy.superAdmins) }, 200);
});

app.openapi(testSandboxStartup, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	assertSessionAuthenticated(c, 'run sandbox startup diagnostics');
	assertSuperAdmin(user, deps.policy);

	const body = c.req.valid('json');
	const image = selectedImage(deps.sandbox.images ?? [], body.image);
	const profile = selectedComputeProfile(
		deps.sandbox.computeProfiles ?? [],
		deps.sandbox.computeProfile,
		deps.sandbox.resources,
		body.compute_profile,
	);
	const sandboxId = createSandboxId();
	const startupTimeoutMs = deps.sandbox.startupTimeoutMs ?? DEFAULT_SANDBOX_STARTUP_TIMEOUT_MS;
	if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) {
		throw new BadRequestError('Sandbox startup diagnostics require a finite startup timeout');
	}
	const diagnosticLease = new SandboxDiagnosticLease(deps.bucket);
	const acquired = await diagnosticLease.acquire(
		user.id,
		sandboxId,
		startupTimeoutMs + STEADY_STATE_EXEC_TIMEOUT_MS + CLEANUP_LEASE_HEADROOM_MS,
	);
	if (!acquired) {
		throw new ResourceExhaustedError('A sandbox startup test is already running');
	}

	const startedAt = new Date().toISOString();
	const started = performance.now();
	let sandbox: SandboxInstance | undefined;
	let handle = skippedPhase();
	let readiness = skippedCommand();
	let exec = skippedCommand();
	let cleanup = skippedPhase();
	let startupTimings: Record<string, number> = {};
	let counters: Record<string, number> = {};

	try {
		const handleStarted = performance.now();
		try {
			sandbox = deps.compute.create(sandboxId, {
				reuse: false,
				...(image ? { image } : {}),
				resources: profile.resources,
			});
			handle = { status: 'ok', duration_ms: elapsed(handleStarted) };
		} catch (error) {
			handle = failedPhase(handleStarted, error);
		}

		if (sandbox) {
			readiness = await runEcho(sandbox, startupTimeoutMs);
			try {
				startupTimings = sandbox.drainTimings?.() ?? {};
			} catch (error) {
				logEvent({
					level: 'error',
					event: 'sandbox_startup_diagnostic_drain_failed',
					request_id: c.get('requestId') ?? null,
					actor: user.id,
					sandbox_id: sandboxId,
					error: errorMetadataChain(error),
				});
			}
			if (readiness.status === 'ok') {
				exec = await runEcho(sandbox, STEADY_STATE_EXEC_TIMEOUT_MS);
			}
		}
	} finally {
		try {
			if (sandbox) {
				try {
					startupTimings = {
						...startupTimings,
						...sandbox.drainTimings?.(),
					};
				} catch (error) {
					logEvent({
						level: 'error',
						event: 'sandbox_startup_diagnostic_drain_failed',
						request_id: c.get('requestId') ?? null,
						actor: user.id,
						sandbox_id: sandboxId,
						error: errorMetadataChain(error),
					});
				}
				try {
					counters = sandbox.drainCounters?.() ?? {};
				} catch (error) {
					logEvent({
						level: 'error',
						event: 'sandbox_startup_diagnostic_counter_drain_failed',
						request_id: c.get('requestId') ?? null,
						actor: user.id,
						sandbox_id: sandboxId,
						error: errorMetadataChain(error),
					});
				}
				const cleanupStarted = performance.now();
				try {
					await sandbox.destroy();
					cleanup = { status: 'ok', duration_ms: elapsed(cleanupStarted) };
				} catch (error) {
					cleanup = failedPhase(cleanupStarted, error);
				}
			}
		} finally {
			await diagnosticLease.release(user.id, sandboxId);
		}
	}

	const report: SandboxStartupReport = {
		ok:
			handle.status === 'ok' &&
			readiness.status === 'ok' &&
			exec.status === 'ok' &&
			cleanup.status === 'ok',
		sandbox_id: sandboxId,
		image: image ?? null,
		compute_profile: profile.name ?? null,
		compute_resources: toComputeResourcesResponse(profile.resources) ?? {},
		started_at: startedAt,
		finished_at: new Date().toISOString(),
		total_ms: elapsed(started),
		handle,
		readiness,
		exec,
		cleanup,
		startup_timings_ms: startupTimings,
		counters,
	};
	logEvent({
		level: report.ok ? 'info' : 'error',
		event: 'sandbox_startup_diagnostic',
		request_id: c.get('requestId') ?? null,
		actor: user.id,
		sandbox_id: sandboxId,
		image: report.image,
		compute_profile: report.compute_profile,
		ok: report.ok,
		total_ms: report.total_ms,
		readiness_ms: report.readiness.duration_ms,
		exec_ms: report.exec.duration_ms,
		cleanup_ms: report.cleanup.duration_ms,
		startup_timings_ms: report.startup_timings_ms,
		counters: report.counters,
	});
	return c.json({ success: true, data: report }, 200);
});

app.openapi(getConfig, (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	assertSessionAuthenticated(c, 'access admin endpoints');
	assertSuperAdmin(user, deps.policy);

	const v = deps.version;
	return c.json(
		{
			success: true,
			data: {
				deployment: v
					? {
							version: v.version,
							image: v.image ?? null,
							sandbox_image: v.sandboxImage ?? null,
							started_at: v.startedAt ?? null,
							replica: v.replica ?? null,
							node: v.node ?? null,
							backends: v.backends ?? null,
						}
					: null,
				groups: (deps.configSummary?.groups ?? []).map((group) => ({
					...group,
					// Belt-and-braces: the summary builder already withholds secret
					// values, but never trust a future source to have done so.
					settings: group.settings.map((s) => ({ ...s, value: s.secret ? null : s.value })),
				})),
				policy: {
					default_role: deps.policy.defaultRole ?? null,
					super_admins: deps.policy.superAdmins ?? [],
				},
			},
		},
		200,
	);
});

export default app;
