/**
 * Cloudflare Workers reference deployment (not an actively-built app — a
 * copy-pasteable example). It composes the SAME provider-agnostic `createApi`
 * with the Cloudflare adapters: R2 storage, Containers compute (Durable Object),
 * and Access auth. This is also the one context where the Cloudflare compute
 * adapter works, since it needs the Workers runtime + DO binding.
 */
import { createApi } from '@marimo-hub/api';
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
	ProjectIntegrationsStore,
	ReconciliationService,
} from '@marimo-hub/core';
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

// Re-export the Sandbox Durable Object so wrangler can discover it, and
// ContainerProxy so the sandbox can mount R2 by binding name without credentials.
export { Sandbox, ContainerProxy };

// Worker R2 binding (wrangler.jsonc `r2_buckets`) the sandbox mounts credential-less.
const R2_BINDING = 'NOTEBOOKS_BUCKET';
let warnedAboutComputeProfiles = false;

/**
 * Deps are built per request here, so a rejected KEK would otherwise surface as
 * an opaque 500 on whichever request happened to arrive first. Name the binding
 * the operator has to fix, the way the Node entrypoint's ConfigError does.
 */
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

export function buildDeps(request: Request, env: Env): ApiDeps {
	const bucket = new R2BucketAdapter(env.NOTEBOOKS_BUCKET);
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

	// Sandbox exposure. Notebook kernels run untrusted code, so they must never be
	// served same-origin with the control plane. Two cross-origin options:
	//   - No SANDBOX_HOSTNAME → quick tunnels: each kernel gets a random, unguessable
	//     `*.trycloudflare.com` URL (zero config).
	//   - SANDBOX_HOSTNAME set → subdomain mode on that isolated domain. Fail closed:
	//     it must NOT share an origin/parent domain with the app host.
	const appHost = new URL(request.url).hostname;
	const sandboxHostname = env.SANDBOX_HOSTNAME;
	const useTunnel = !sandboxHostname;
	if (
		sandboxHostname &&
		(sandboxHostname === appHost ||
			sandboxHostname.endsWith(`.${appHost}`) ||
			appHost.endsWith(`.${sandboxHostname}`))
	) {
		throw new Error(
			`SANDBOX_HOSTNAME (${sandboxHostname}) shares an origin/parent domain with the app host (${appHost}). ` +
				'Host notebook kernels on a separate domain so a malicious notebook cannot escape the iframe sandbox.',
		);
	}

	// Managed AI: front an OpenAI-compatible upstream so notebooks get the AI
	// assistant with no user key. Enabled only when all four secrets are set; the
	// real upstream key stays here and is never injected into a sandbox.
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

	const services = createServices(bucket);
	return {
		services,
		bucket,
		compute: new CloudflareSandboxProvider(env.SANDBOX, { useTunnel }),
		// Personal access tokens (`Authorization: Bearer mhub_pat_…`) work on every
		// deployment; other requests resolve through the adapter selected above.
		authenticator: composeAuthenticators(services.tokens, authenticator),
		ai,
		// Secret-free integrations work without a KEK; secret fields require SECRETS_KEK.
		// No `probe` — Workers lack the DNS hooks the guarded egress policy needs,
		// so connection testing stays disabled here.
		integrations: new ProjectIntegrationsStore({
			bucket,
			registry: defaultRegistry(),
			codec: secretCodec(env.SECRETS_KEK),
		}),
		orgIntegrations: new OrgIntegrationsStore({
			bucket,
			registry: defaultRegistry(),
			codec: secretCodec(env.SECRETS_KEK),
		}),
		sandbox: {
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
			workdir: env.SANDBOX_WORKDIR || '/workspace',
			computeProfiles: [],
			computeProfileOverride: 'none',
			// Which sandbox working-dir files survive a session. `source` persists only
			// the source files; `workspace` also captures runtime files (e.g. generated
			// data) into the notebook workspace on teardown and restores them next time.
			persistWorkspace: env.PERSIST_WORKSPACE === 'workspace' ? 'workspace' : 'source',
		},
		policy: {
			editorSandboxSharing: parseEditorSandboxSharing(env.MARIMOHUB_EDITOR_SANDBOX_SHARING),
			// Fallback role for logged-in non-members; defaults to `editor` so any
			// logged-in user can edit notebooks. Set DEFAULT_ROLE=none to keep writes
			// members-only. Project edit/delete always requires manager.
			defaultRole: parseDefaultRole(env.DEFAULT_ROLE),
			// Comma-separated user ids/emails granted implicit admin on every project.
			// Read under the documented, config-package name so the reference deployment
			// honors what docs/configuration.md advertises.
			superAdmins: env.MARIMOHUB_SUPER_ADMINS?.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
		},
		// Deployment metadata for GET /api/v1/version (UI footer). On Workers there's no
		// Docker image to report (image/sandboxImage stay null → hidden), but the
		// resolved backends are known from this wiring.
		version: {
			version: 'dev',
			backends: { storage: 'r2', compute: 'cloudflare', auth: env.AUTH_MODE ?? 'unset' },
		},
	};
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
		// `buildDeps` fails closed on misconfiguration (e.g. AUTH_MODE/SANDBOX_HOSTNAME).
		// Surface a readable 500 instead of an opaque Workers error so the operator can
		// see what to fix in the deployment vars.
		let api: ReturnType<typeof createApi>;
		try {
			api = createApi(buildDeps(request, env));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return new Response(
				JSON.stringify({ success: false, error: { code: 'CONFIG_ERROR', message } }),
				{ status: 500, headers: { 'content-type': 'application/json' } },
			);
		}
		return api.fetch(request, env, ctx);
	},
	async scheduled(_event: ScheduledController, env: Env): Promise<void> {
		const bucket = new R2BucketAdapter(env.NOTEBOOKS_BUCKET);
		const { sessions, maintenance, notebooks, idempotency } = createServices(bucket);
		const compute = new CloudflareSandboxProvider(env.SANDBOX);

		// The Workers scheduled trigger is already a platform singleton; the lease
		// is belt-and-suspenders, matching the Node deployment's contract.
		const lock = new MaintenanceLock(bucket);
		if (!(await lock.acquire('cloudflare-scheduled'))) return;
		try {
			await sessions.expireStale();
			// Reconcile records against the provider. The Cloudflare adapter omits
			// listActive(), so this cleanly no-ops until that backend can enumerate.
			await new ReconciliationService(
				sessions,
				notebooks,
				compute,
				bucket,
				env.PERSIST_WORKSPACE === 'workspace' ? 'workspace' : 'source',
			).reconcile();
			await sessions.reapTerminated();
			await maintenance.expireSnapshots();
			await maintenance.pruneEvents();
			await idempotency.prune();
		} finally {
			await lock.release('cloudflare-scheduled');
		}
	},
};
