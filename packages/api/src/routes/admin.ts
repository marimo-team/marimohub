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
	extensibleResponseEnum,
	jsonContent,
	SESSION_ONLY_SECURITY,
	toComputeResourcesResponse,
} from '../shared';
import { appendAudit, errorMetadataChain, logEvent } from '../log';
import { pageSchema } from '../pagination';

const ECHO_COMMAND = 'echo "Hello"';
const STEADY_STATE_EXEC_TIMEOUT_MS = 30_000;
const UV_BENCHMARK_RUNTIME_TIMEOUT_MS = 30_000;
const UV_BENCHMARK_DOWNLOAD_TIMEOUT_MS = 60_000;
const UV_BENCHMARK_LOCK_TIMEOUT_MS = 120_000;
const UV_BENCHMARK_SYNC_TIMEOUT_MS = 300_000;
const UV_BENCHMARK_TIMEOUT_MS =
	UV_BENCHMARK_RUNTIME_TIMEOUT_MS +
	UV_BENCHMARK_DOWNLOAD_TIMEOUT_MS +
	UV_BENCHMARK_LOCK_TIMEOUT_MS +
	UV_BENCHMARK_SYNC_TIMEOUT_MS;
const CLEANUP_LEASE_HEADROOM_MS = 60_000;
const UV_BENCHMARK_DIR = '/tmp/marimohub-uv-sync-benchmark';
// boto3 (and its botocore dependency) is absent from the sandbox base image, so
// `uv sync` below does real install work. A "popular" package that ships in the
// image — e.g. pandas — would already be satisfied and the sync phase would
// measure nothing.
const BOTOCORE_WHEEL_URL =
	'https://files.pythonhosted.org/packages/64/93/7bba357266450f7d3e3075ee4d2f1e1d96c1617e40d8065c558485baed78/botocore-1.43.80-py3-none-any.whl';

const UV_BENCHMARK_RUNTIME_COMMAND = [
	'set -eu',
	"printf 'uname='",
	'uname -a',
	"printf 'kernel_osrelease='",
	'cat /proc/sys/kernel/osrelease',
	"printf 'kernel_version='",
	'cat /proc/version',
	"printf 'nproc='",
	'nproc',
	'printf \'UV_PROJECT_ENVIRONMENT=%s\\n\' "${UV_PROJECT_ENVIRONMENT:-unset}"',
	'printf \'UV_CACHE_DIR=%s\\n\' "${UV_CACHE_DIR:-unset}"',
	"if [ -d /proc/gvisor ]; then printf 'runtime_probe=gvisor (/proc/gvisor)\\n'; elif dmesg 2>&1 | grep -qi gvisor; then printf 'runtime_probe=gvisor (dmesg)\\n'; else printf 'runtime_probe=no-gvisor-marker\\n'; fi",
	"printf '%s\\n' '--- dmesg (first 20 lines) ---'",
	"dmesg 2>&1 | sed -n '1,20p' || true",
	"printf '%s\\n' '--- /proc/1/status ---'",
	"grep -E '^(Seccomp|Seccomp_filters|Cpus_allowed_list):' /proc/1/status || true",
	'for path in /sys/fs/cgroup/cpu.max /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/cpu/cpu.cfs_period_us /sys/fs/cgroup/cpu/cpu.stat; do if [ -r "$path" ]; then printf \'%s\\n\' "--- $path ---"; cat "$path"; fi; done',
].join('\n');

const UV_BENCHMARK_DOWNLOAD_COMMAND = [
	'set -eu',
	'curl --fail --location --silent --show-error --output /dev/null',
	"--write-out 'http_code=%{http_code}\\nsize_download=%{size_download}\\ntime_namelookup=%{time_namelookup}\\ntime_connect=%{time_connect}\\ntime_appconnect=%{time_appconnect}\\ntime_starttransfer=%{time_starttransfer}\\ntime_total=%{time_total}\\nspeed_download=%{speed_download}\\n'",
	`'${BOTOCORE_WHEEL_URL}'`,
].join(' ');

const UV_BENCHMARK_LOCK_COMMAND = [
	'set -eu',
	`benchmark_dir='${UV_BENCHMARK_DIR}'`,
	'rm -rf "$benchmark_dir"',
	'mkdir -p "$benchmark_dir"',
	"printf '%s\\n' '[project]' 'name = \"marimohub-uv-benchmark\"' 'version = \"0.0.0\"' 'requires-python = \">=3.13\"' 'dependencies = [' '  \"boto3==1.43.80\",' ']' > \"$benchmark_dir/pyproject.toml\"",
	'cd "$benchmark_dir"',
	'uv lock --no-cache',
].join('\n');

const UV_BENCHMARK_SYNC_COMMAND = [
	'set -u',
	`benchmark_dir='${UV_BENCHMARK_DIR}'`,
	'cd "$benchmark_dir"',
	'record_cpu_stat() {',
	'  label="$1"',
	'  if [ -r /sys/fs/cgroup/cpu.stat ]; then',
	'    printf "%s\\n" "--- $label /sys/fs/cgroup/cpu.stat ---"',
	'    cat /sys/fs/cgroup/cpu.stat',
	'  elif [ -r /sys/fs/cgroup/cpu/cpu.stat ]; then',
	'    printf "%s\\n" "--- $label /sys/fs/cgroup/cpu/cpu.stat ---"',
	'    cat /sys/fs/cgroup/cpu/cpu.stat',
	'  fi',
	'}',
	'record_cpu_stat cpu_before',
	'status=0',
	'uv sync --frozen --inexact --no-compile-bytecode --no-build -v > "$benchmark_dir/uv-sync.log" 2>&1 || status=$?',
	'grep -E \'(^|[[:space:]])(Resolved|Prepared|Installed) [0-9]+ package\' "$benchmark_dir/uv-sync.log" || true',
	'record_cpu_stat cpu_after',
	'if [ "$status" -ne 0 ]; then tail -n 100 "$benchmark_dir/uv-sync.log" >&2; fi',
	'exit "$status"',
].join('\n');

/**
 * A container start on a warm node is a few seconds. A `boot` timing above this
 * is almost always the node pulling the sandbox image because the tag was not
 * in its cache; the fix is operational (pre-pull the tags on the sandbox node
 * pool), so the log line says so instead of leaving it to be rediscovered.
 */
const SLOW_BOOT_MS = 10_000;
const SLOW_BOOT_HINT =
	'boot > 10 s usually means the node cold-pulled the sandbox image; pre-pull the configured image tags on the sandbox node pool';

const SandboxStartupPhaseSchema = z
	.object({
		status: extensibleResponseEnum(['ok', 'failed', 'skipped'], 'ok'),
		duration_ms: z.number().nonnegative().nullable(),
		error: z.record(z.string(), z.unknown()).optional(),
	})
	.openapi('SandboxStartupPhase');

const SandboxStartupCommandSchema = SandboxStartupPhaseSchema.extend({
	command: z.string().openapi({ example: ECHO_COMMAND }),
	stdout: z.string(),
	stderr: z.string(),
	failure_code: extensibleResponseEnum(
		['COMMAND_FAILED', 'SPAWN_FAILED', 'BACKEND_ERROR'],
		'COMMAND_FAILED',
	).optional(),
}).openapi('SandboxStartupCommand');

const SandboxStartupRequestSchema = z
	.object({
		image: z.string().min(1).optional(),
		compute_profile: z.string().min(1).optional(),
		environment_setup_benchmark: z.boolean().optional().openapi({
			description:
				'Run the fixed-package uv, wheel-download, runtime, and CPU-throttling benchmark',
		}),
	})
	.strict()
	.openapi('SandboxStartupRequest');

const SandboxEnvironmentSetupBenchmarkSchema = z
	.object({
		tool: z.string().min(1).openapi({ example: 'uv' }),
		runtime_probe: SandboxStartupCommandSchema,
		artifact_download: SandboxStartupCommandSchema,
		prepare: SandboxStartupCommandSchema,
		install: SandboxStartupCommandSchema,
	})
	.openapi('SandboxEnvironmentSetupBenchmark');

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
		environment_setup_benchmark: SandboxEnvironmentSetupBenchmarkSchema.nullable().openapi({
			description: 'The optional fixed-package benchmark, or null when it was not requested',
		}),
	})
	.openapi('SandboxStartupReport');

type SandboxStartupPhase = z.infer<typeof SandboxStartupPhaseSchema>;
type SandboxStartupCommand = z.infer<typeof SandboxStartupCommandSchema>;
type SandboxStartupReport = z.infer<typeof SandboxStartupReportSchema>;
type EnvironmentSetupBenchmark = NonNullable<SandboxStartupReport['environment_setup_benchmark']>;

function elapsed(started: number): number {
	return performance.now() - started;
}

function skippedPhase(): SandboxStartupPhase {
	return { status: 'skipped', duration_ms: null };
}

function skippedCommand(command = ECHO_COMMAND): SandboxStartupCommand {
	return {
		...skippedPhase(),
		command,
		stdout: '',
		stderr: '',
	};
}

function skippedEnvironmentSetupBenchmark(): EnvironmentSetupBenchmark {
	return {
		tool: 'uv',
		runtime_probe: skippedCommand(UV_BENCHMARK_RUNTIME_COMMAND),
		artifact_download: skippedCommand(UV_BENCHMARK_DOWNLOAD_COMMAND),
		prepare: skippedCommand(UV_BENCHMARK_LOCK_COMMAND),
		install: skippedCommand(UV_BENCHMARK_SYNC_COMMAND),
	};
}

function failedPhase(started: number, error: unknown): SandboxStartupPhase {
	return {
		status: 'failed',
		duration_ms: elapsed(started),
		error: errorMetadataChain(error),
	};
}

async function runCommand(
	sandbox: SandboxInstance,
	command: string,
	timeout: number,
): Promise<SandboxStartupCommand> {
	const started = performance.now();
	try {
		const result = await sandbox.exec(command, { timeout });
		return result.success
			? {
					status: 'ok',
					duration_ms: elapsed(started),
					command,
					stdout: result.stdout,
					stderr: result.stderr,
				}
			: {
					status: 'failed',
					duration_ms: elapsed(started),
					command,
					stdout: result.stdout,
					stderr: result.stderr,
					failure_code: result.error.code,
				};
	} catch (error) {
		return {
			...failedPhase(started, error),
			command,
			stdout: '',
			stderr: '',
		};
	}
}

function runEcho(sandbox: SandboxInstance, timeout: number): Promise<SandboxStartupCommand> {
	return runCommand(sandbox, ECHO_COMMAND, timeout);
}

function commandLogSummary(command: SandboxStartupCommand) {
	return { status: command.status, duration_ms: command.duration_ms };
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
		'probe, and measures a second fixed echo command. An optional fresh-sandbox uv benchmark ' +
		'also records runtime and CPU limits, files.pythonhosted.org throughput, uv phase timings, ' +
		'and CPU throttling counters. The sandbox is always destroyed. Runtime failures are returned ' +
		'as a partial report. Super-admin only and session-only.',
	security: SESSION_ONLY_SECURITY,
	request: {
		body: {
			content: { 'application/json': { schema: SandboxStartupRequestSchema } },
			required: false,
			description: 'Optional; omit to use the deployment defaults.',
		},
	},
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
	await assertSuperAdmin(user, deps.policy);

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
	await assertSuperAdmin(actor, deps.policy);
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
	await assertSuperAdmin(actor, deps.policy);
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
	await assertSuperAdmin(user, deps.policy);

	const body = c.req.valid('json') ?? {};
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
		startupTimeoutMs +
			STEADY_STATE_EXEC_TIMEOUT_MS +
			(body.environment_setup_benchmark ? UV_BENCHMARK_TIMEOUT_MS : 0) +
			CLEANUP_LEASE_HEADROOM_MS,
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
	const environmentSetupBenchmark = body.environment_setup_benchmark
		? skippedEnvironmentSetupBenchmark()
		: null;
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
				if (environmentSetupBenchmark) {
					environmentSetupBenchmark.runtime_probe = await runCommand(
						sandbox,
						UV_BENCHMARK_RUNTIME_COMMAND,
						UV_BENCHMARK_RUNTIME_TIMEOUT_MS,
					);
					environmentSetupBenchmark.artifact_download = await runCommand(
						sandbox,
						UV_BENCHMARK_DOWNLOAD_COMMAND,
						UV_BENCHMARK_DOWNLOAD_TIMEOUT_MS,
					);
					environmentSetupBenchmark.prepare = await runCommand(
						sandbox,
						UV_BENCHMARK_LOCK_COMMAND,
						UV_BENCHMARK_LOCK_TIMEOUT_MS,
					);
					if (environmentSetupBenchmark.prepare.status === 'ok') {
						environmentSetupBenchmark.install = await runCommand(
							sandbox,
							UV_BENCHMARK_SYNC_COMMAND,
							UV_BENCHMARK_SYNC_TIMEOUT_MS,
						);
					}
				}
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

	const benchmarkOk =
		environmentSetupBenchmark === null ||
		[
			environmentSetupBenchmark.runtime_probe,
			environmentSetupBenchmark.artifact_download,
			environmentSetupBenchmark.prepare,
			environmentSetupBenchmark.install,
		].every((command) => command.status === 'ok');
	const report: SandboxStartupReport = {
		ok:
			handle.status === 'ok' &&
			readiness.status === 'ok' &&
			exec.status === 'ok' &&
			benchmarkOk &&
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
		environment_setup_benchmark: environmentSetupBenchmark,
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
		environment_setup_benchmark:
			report.environment_setup_benchmark === null
				? null
				: {
						tool: report.environment_setup_benchmark.tool,
						runtime_probe: commandLogSummary(report.environment_setup_benchmark.runtime_probe),
						artifact_download: commandLogSummary(
							report.environment_setup_benchmark.artifact_download,
						),
						prepare: commandLogSummary(report.environment_setup_benchmark.prepare),
						install: commandLogSummary(report.environment_setup_benchmark.install),
					},
		startup_timings_ms: report.startup_timings_ms,
		counters: report.counters,
		...((report.startup_timings_ms.boot ?? 0) > SLOW_BOOT_MS ? { hint: SLOW_BOOT_HINT } : {}),
	});
	return c.json({ success: true, data: report }, 200);
});

app.openapi(getConfig, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	assertSessionAuthenticated(c, 'access admin endpoints');
	await assertSuperAdmin(user, deps.policy);

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
