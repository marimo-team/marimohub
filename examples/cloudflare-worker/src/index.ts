import { AsyncLocalStorage } from 'node:async_hooks';
import { parseTheme } from '@marimo-hub/config/theme';
// Reference deployment: the shared API with R2 storage, Cloudflare Containers, and Access auth.
import { hostsOverlap, normalizeHostname } from '@marimo-hub/core/host-isolation';
import type { BackgroundWork } from '@marimo-hub/core/ports/background-work';
import { parseAppPoolPolicy } from '@marimo-hub/config/app-pool';
import {
	createApi,
	DEFAULT_JOBS_CONFIG,
	resolveJobSandboxEnv,
	sweepAppPools,
} from '@marimo-hub/api';
import type { ApiDeps } from '@marimo-hub/api';
import {
	AesGcmSecretCodec,
	ASSIGNABLE_ROLES,
	composeAuthenticators,
	createServices,
	defaultRegistry,
	EDITOR_SANDBOX_SHARING_VALUES,
	foldCase,
	MaintenanceLock,
	OrgIntegrationsStore,
	paths,
	ProjectIntegrationsStore,
	ReconciliationService,
	weakMemo,
} from '@marimo-hub/core';
import { JobRunner, JobScheduler } from '@marimo-hub/core/jobs';
import type { AssignableRole, EditorSandboxSharing } from '@marimo-hub/core';
import { CloudflareAccessAuthenticator } from '@marimo-hub/auth-cloudflare-access';
import { DevAuthenticator } from '@marimo-hub/auth-dev';
import { CloudflareSandboxProvider, ContainerProxy, Sandbox } from '@marimo-hub/compute-cloudflare';
import {
	parseComputeProfileOverride,
	parseComputeProfiles,
	unsupportedBackendNotice,
} from '@marimo-hub/config/compute-profiles';
import { R2BucketAdapter } from '@marimo-hub/storage-r2';
import { parseSandboxAuth } from '@marimo-hub/config/sandbox-auth';
import { parseSandboxAssetUrl } from '@marimo-hub/config/sandbox-assets';
import { notebookBridgeRuntime } from '@marimo-hub/notebook-bridge/runtime';

// Re-export the Sandbox Durable Object so wrangler can discover it, and
// ContainerProxy so the sandbox can mount R2 by binding name without credentials.
export { Sandbox, ContainerProxy };

// Worker R2 binding (wrangler.jsonc `r2_buckets`) the sandbox mounts credential-less.
const R2_BINDING = 'NOTEBOOKS_BUCKET';
const notebookBridge = notebookBridgeRuntime();
let warnedAboutComputeProfiles = false;
// Shared services must register work on the invocation that started it.
const executionContext = new AsyncLocalStorage<Pick<ExecutionContext, 'waitUntil'>>();
const backgroundWork: BackgroundWork = {
	async defer(_label, task) {
		const ctx = executionContext.getStore();
		const work = Promise.resolve().then(task);
		if (ctx) ctx.waitUntil(work);
		else await work;
	},
};

// Key by env identity so binding changes get fresh dependencies.
// Maintenance uses these resources without validating HTTP-only configuration.
const deploymentResources = weakMemo((env: Env) => {
	const bucket = new R2BucketAdapter(env.NOTEBOOKS_BUCKET);
	return {
		bucket,
		services: createServices(bucket, undefined, { backgroundWork }),
		compute: new CloudflareSandboxProvider(env.SANDBOX, {
			useTunnel: !env.SANDBOX_HOSTNAME?.trim(),
		}),
	};
});
const deploymentDeps = weakMemo(createDeploymentDeps);
const deploymentApi = weakMemo((deps: ApiDeps) => createApi(deps));

function secretCodec(kek: string | undefined): AesGcmSecretCodec | undefined {
	if (!kek) return undefined;
	try {
		return new AesGcmSecretCodec({ kek });
	} catch (err) {
		throw new Error(
			`Invalid SECRETS_KEK secret: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function parseJobsToggle(raw: string | undefined): boolean {
	const value = raw?.trim().toLowerCase();
	if (value === undefined || value === '' || value === 'off') return false;
	if (value === 'on') return true;
	throw new Error(`Unknown MARIMOHUB_JOBS: ${raw} (supported: on, off).`);
}

function parseEditorSandboxSharing(raw: string | undefined): EditorSandboxSharing {
	const sharing = foldCase(raw ?? '') || 'shared';
	const parsed = EDITOR_SANDBOX_SHARING_VALUES.find((candidate) => candidate === sharing);
	if (parsed) return parsed;
	throw new Error(
		`Invalid MARIMOHUB_EDITOR_SANDBOX_SHARING: ${raw} ` +
			`(expected ${EDITOR_SANDBOX_SHARING_VALUES.join(', ')})`,
	);
}

function parseDefaultRole(raw: string | undefined): AssignableRole | undefined {
	const role = foldCase(raw ?? '') || 'editor';
	if (role === 'none') return undefined;
	const parsed = ASSIGNABLE_ROLES.find((candidate) => candidate === role);
	if (parsed) return parsed;
	throw new Error(`Invalid DEFAULT_ROLE: ${raw} (expected ${ASSIGNABLE_ROLES.join(', ')}, none)`);
}

// The host check must run for every request, including cache hits.
export function buildDeps(request: Request, env: Env): ApiDeps {
	const deps = deploymentDeps(env);
	const appHost = new URL(request.url).hostname;
	const sandboxHostname = deps.sandbox.hostname;
	if (sandboxHostname && hostsOverlap(sandboxHostname, appHost)) {
		throw new Error(
			`SANDBOX_HOSTNAME (${sandboxHostname}) shares an origin/parent domain with the app host (${appHost}). ` +
				'Use a different sandbox hostname that is not a parent or subdomain of the app hostname.',
		);
	}
	return deps;
}

function createDeploymentDeps(env: Env): ApiDeps {
	const { bucket, services, compute } = deploymentResources(env);
	const computeProfiles = parseComputeProfiles(env.MARIMOHUB_COMPUTE_PROFILES);
	parseComputeProfileOverride(env.MARIMOHUB_COMPUTE_PROFILE_OVERRIDE);
	const profileNotice = unsupportedBackendNotice('cloudflare', computeProfiles);
	if (profileNotice && !warnedAboutComputeProfiles) {
		console.warn(profileNotice);
		warnedAboutComputeProfiles = true;
	}

	let authenticator;
	if (env.AUTH_MODE === 'access') {
		authenticator = new CloudflareAccessAuthenticator({
			team: env.ACCESS_TEAM ?? '',
			aud: env.ACCESS_AUD ?? '',
		});
	} else if (env.AUTH_MODE === 'dev') {
		// Explicit dev bypass — authenticates every request as a fixed local user.
		// NEVER use in a deployment that serves real users.
		authenticator = new DevAuthenticator({ userId: env.USER_ID, email: env.USER_EMAIL });
	} else {
		throw new Error(
			'AUTH_MODE must be set explicitly to "access" or "dev". Refusing to start: ' +
				'an unset/other AUTH_MODE previously defaulted to the insecure dev bypass.',
		);
	}

	// Without a sandbox hostname, quick tunnels give each kernel a random URL.
	const sandboxHostname = env.SANDBOX_HOSTNAME?.trim()
		? normalizeHostname(env.SANDBOX_HOSTNAME)
		: undefined;

	// The upstream API key stays in the Worker, never in a sandbox.
	const ai: ApiDeps['ai'] =
		env.AI_UPSTREAM_BASE_URL && env.AI_UPSTREAM_API_KEY && env.AI_MODEL && env.AI_SESSION_SECRET
			? {
					upstreamBaseUrl: env.AI_UPSTREAM_BASE_URL.replace(/\/+$/, ''),
					upstreamApiKey: env.AI_UPSTREAM_API_KEY,
					model: env.AI_MODEL,
					signingSecret: env.AI_SESSION_SECRET,
					upstreamProject: env.AI_UPSTREAM_PROJECT,
				}
			: undefined;

	const integrationOptions = {
		bucket,
		registry: defaultRegistry(),
		codec: secretCodec(env.SECRETS_KEK),
	};

	return {
		theme: parseTheme(env),
		backgroundWork,
		teardownInline: true,
		services,
		bucket,
		compute,
		// Personal access tokens (`Authorization: Bearer mhub_pat_…`) work on every
		// deployment; other requests resolve through the adapter selected above.
		authenticator: composeAuthenticators(services.tokens, authenticator),
		ai,
		// Secret fields require a KEK. Probes require DNS hooks unavailable in Workers.
		integrations: new ProjectIntegrationsStore(integrationOptions),
		orgIntegrations: new OrgIntegrationsStore(integrationOptions),
		sandbox: {
			appBaseUrl: env.MARIMOHUB_APP_BASE_URL?.trim() || undefined,
			// Default: credential-less R2 binding mount (no endpoint/secrets) — the
			// sandbox mounts the bucket by Worker binding name. Set R2_S3_ENDPOINT to
			// mount an external S3-compatible bucket with credentials instead.
			bucket: env.R2_S3_ENDPOINT
				? {
						name: env.R2_BUCKET_NAME ?? '',
						endpoint: env.R2_S3_ENDPOINT,
						credentials:
							env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
								? { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }
								: undefined,
					}
				: { name: R2_BINDING },
			// Empty in tunnel mode (the adapter ignores it then); set only for
			// subdomain exposure on a dedicated isolated domain.
			hostname: sandboxHostname ?? '',
			auth: parseSandboxAuth(env.MARIMOHUB_SANDBOX_AUTH),
			workdir: env.SANDBOX_WORKDIR || '/workspace',
			assetUrl: parseSandboxAssetUrl(env.MARIMOHUB_COMPUTE_ASSET_URL),
			notebookBridge,
			computeProfiles: [],
			computeProfileOverride: 'none',
			automaticThumbnails: env.MARIMOHUB_AUTOMATIC_THUMBNAILS !== 'false',
			// Which sandbox working-dir files survive a session. `source` persists only
			// the source files; `workspace` also captures runtime files (e.g. generated
			// data) into the notebook workspace on teardown and restores them next time.
			persistWorkspace: env.PERSIST_WORKSPACE === 'workspace' ? 'workspace' : 'source',
		},
		// Documented on/off toggle; the Node tuning knobs keep their defaults here.
		jobs: parseJobsToggle(env.MARIMOHUB_JOBS) ? DEFAULT_JOBS_CONFIG : undefined,
		policy: {
			appPool: parseAppPoolPolicy(env),
			editorSandboxSharing: parseEditorSandboxSharing(env.MARIMOHUB_EDITOR_SANDBOX_SHARING),
			// Fallback role for logged-in non-members; defaults to `editor` so any
			// logged-in user can edit notebooks. Set DEFAULT_ROLE=none to keep writes
			// members-only. Project edit/delete always requires manager.
			defaultRole: parseDefaultRole(env.DEFAULT_ROLE),
			// These user IDs and emails have admin access to every project.
			superAdmins: env.MARIMOHUB_SUPER_ADMINS?.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
		},
		// Workers have no deployment image to report in the UI footer.
		version: {
			version: 'dev',
			backends: { storage: 'r2', compute: 'cloudflare', auth: env.AUTH_MODE ?? 'unset' },
		},
	};
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
		// Report configuration failures with the binding name for operators.
		let api: ReturnType<typeof createApi>;
		try {
			api = deploymentApi(buildDeps(request, env));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return new Response(
				JSON.stringify({ success: false, error: { code: 'CONFIG_ERROR', message } }),
				{ status: 500, headers: { 'content-type': 'application/json' } },
			);
		}
		return executionContext.run(ctx, () => api.fetch(request, env, ctx));
	},
	scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		return executionContext.run(ctx, () => runScheduled(env, ctx));
	},
};

async function runScheduled(env: Env, ctx: ExecutionContext): Promise<void> {
	const { bucket, services, compute } = deploymentResources(env);
	const {
		sessions,
		maintenance,
		projects,
		notebooks,
		proposals,
		idempotency,
		jobRuns,
		hostRetries,
	} = services;

	// The lease prevents overlapping maintenance from different invocations.
	const lock = new MaintenanceLock(bucket);
	if (await lock.acquire('cloudflare-scheduled')) {
		try {
			await sweepAppPools({
				bucket,
				compute,
				services,
				policy: {
					appPool: parseAppPoolPolicy(env),
				},
				sandbox: {
					workdir: env.SANDBOX_WORKDIR ?? '/workspace',
					persistWorkspace: env.PERSIST_WORKSPACE === 'workspace' ? 'workspace' : 'source',
				},
			});
			await sessions.expireStale();
			// Reconcile still reclaims terminal sessions from their records. The Cloudflare
			// adapter omits listActive() and connectExisting(), so orphan reaping is skipped
			// and sessions that may need a save wait for an admin discard.
			const reconciler = new ReconciliationService(
				sessions,
				notebooks,
				compute,
				bucket,
				env.PERSIST_WORKSPACE === 'workspace' ? 'workspace' : 'source',
				undefined,
				jobRuns,
				{ automaticThumbnails: env.MARIMOHUB_AUTOMATIC_THUMBNAILS !== 'false' },
			);
			await reconciler.reconcile();
			// Reclaims that outlive their deadline keep running; keep the isolate alive for them.
			ctx.waitUntil(reconciler.drain());
			await sessions.reapTerminated();
			await maintenance.expireSnapshots();
			await maintenance.pruneEvents();
			await idempotency.prune();
			await hostRetries.compactExpired();
			await proposals.pruneExpiredPayloads();
			await projects.claimPendingInvites();
		} finally {
			await lock.release('cloudflare-scheduled');
		}
	}

	// Jobs use a separate lease and the configured five-minute cron interval.
	// waitUntil retains active runs until the invocation limit. The watchdog reclaims unfinished runs.
	if (!parseJobsToggle(env.MARIMOHUB_JOBS)) return;
	const jobsLock = new MaintenanceLock(bucket, paths.jobSchedulerLock);
	if (!(await jobsLock.acquire('cloudflare-scheduled'))) return;
	try {
		const deps = deploymentDeps(env);
		const scheduler = new JobScheduler({
			catalog: deps.services.catalog,
			jobs: deps.services.jobs,
			runs: deps.services.jobRuns,
			runner: new JobRunner({
				bucket,
				compute,
				notebooks: deps.services.notebooks,
				projects: deps.services.projects,
				jobs: deps.services.jobs,
				runs: deps.services.jobRuns,
				sandbox: { bucket: deps.sandbox.bucket, workdir: deps.sandbox.workdir },
				resolveSessionEnv: (context) => resolveJobSandboxEnv(deps, context),
			}),
			compute,
			notebooks: deps.services.notebooks,
			projects: deps.services.projects,
			events: deps.services.events,
			config: DEFAULT_JOBS_CONFIG,
		});
		await scheduler.tick();
		ctx.waitUntil(scheduler.drain());
		await scheduler.prune(DEFAULT_JOBS_CONFIG.runRetentionMs);
	} finally {
		await jobsLock.release('cloudflare-scheduled');
	}
}
