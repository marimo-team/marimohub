/**
 * Concrete preflight checks. This lives in `config` (not `core`) because it needs
 * concrete endpoints/credentials and the wired adapters — `core` only owns the
 * vendor-free runner (`runPreflight`). Each check returns a `CheckOutcome`; the
 * runner isolates and times them out.
 *
 * Severity convention:
 *   - `fail` + `fatal: true` — a deterministic, unsafe-to-run misconfiguration a
 *     restart can't fix (store ignores conditional writes, malformed WIF key). The
 *     boot path exits on these.
 *   - `fail` (no `fatal`) — a dependency is down/unreachable. Logged as an error,
 *     surfaced as 503 by the deep health endpoint, but the server keeps serving so
 *     a transient blip never crashloops a replica.
 *   - `warn` — config looks incomplete but may be intentional.
 *   - `skipped` — not applicable to this backend.
 */
import type { ApiDeps } from '@marimo-hub/api';
import type { CheckOutcome, PreflightCheck } from '@marimo-hub/core';
import { authBackend } from './auth';
import { computeBackend } from './compute';
import type { Env } from './env';
import { checkSandboxHostIsolation } from './hostIsolation';
import { storageBackend } from './storage';

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function fetchWithTimeout(
	url: string,
	timeoutMs: number,
	init?: RequestInit,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, {
			method: 'GET',
			redirect: 'follow',
			...init,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}

async function checkStorage(env: Env, deps: ApiDeps): Promise<CheckOutcome> {
	const backend = storageBackend(env);
	const bucket = deps.bucket as {
		verifyConditionalWrites?: () => Promise<void>;
		casScope?: 'process' | 'global';
	};
	if (typeof bucket.verifyConditionalWrites !== 'function') {
		return { status: 'skipped', message: `${backend} backend: no conditional-write probe` };
	}
	try {
		await bucket.verifyConditionalWrites();
		if (bucket.casScope === 'process') {
			return {
				status: 'warn',
				message:
					`${backend} storage enforces conditional writes within this process only — ` +
					'concurrent hub replicas sharing the same storage can lose catalog updates',
				remediation:
					'Run a single hub replica against this storage, or use s3/gcs/azure for multi-replica deployments.',
			};
		}
		return { status: 'ok', message: `${backend} reachable and honors conditional writes` };
	} catch (err) {
		const message = errMsg(err);
		// A reachable store that demonstrably ignores If-Match is data-unsafe and
		// deterministic — the catalog CAS would silently lose updates. Fatal. The
		// match keys off the capability-violation wording both storage adapters throw
		// ("…does NOT enforce/apply conditional writes…"); any other error (network,
		// permissions) is transient and stays non-fatal.
		if (/does NOT (enforce|apply) conditional writes/i.test(message)) {
			return {
				status: 'fail',
				fatal: true,
				message,
				remediation:
					'Use Azure Blob Storage, GCS, AWS S3, Cloudflare R2, or a recent MinIO that enforces atomic conditional writes.',
			};
		}
		return {
			status: 'fail',
			message: `Could not verify storage: ${message}`,
			remediation: 'Check the bucket/container name, endpoint, region, and credentials.',
		};
	}
}

async function checkAuth(env: Env): Promise<CheckOutcome> {
	const backend = authBackend(env);
	if (backend !== 'oidc') {
		return { status: 'skipped', message: `${backend ?? 'unset'} backend: no discovery probe` };
	}
	const issuer = env.MARIMOHUB_AUTH_OIDC_ISSUER;
	if (!issuer) return { status: 'skipped', message: 'OIDC issuer not set' };
	const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
	try {
		const res = await fetchWithTimeout(url, 2500);
		if (res.ok) return { status: 'ok', message: `OIDC issuer discoverable (${issuer})` };
		return {
			status: 'fail',
			message: `OIDC discovery returned ${res.status} for ${url}`,
			remediation: 'Set MARIMOHUB_AUTH_OIDC_ISSUER to the IdP base URL (no trailing path).',
		};
	} catch (err) {
		return {
			status: 'fail',
			message: `OIDC issuer unreachable: ${errMsg(err)}`,
			remediation: 'Verify MARIMOHUB_AUTH_OIDC_ISSUER and network egress to the IdP.',
		};
	}
}

function checkIsolation(env: Env, deps: ApiDeps): CheckOutcome {
	if (deps.sandbox.exposure?.mode !== 'subdomain') {
		return { status: 'skipped', message: 'proxy mode is same-origin by design' };
	}
	const { isolated, sandboxHost, appHost } = checkSandboxHostIsolation(env);
	if (isolated) {
		return {
			status: 'ok',
			message: sandboxHost
				? `kernel host ${sandboxHost} isolated from the app`
				: 'no kernel host set',
		};
	}
	return {
		status: 'fail',
		fatal: true,
		message: `kernel host ${sandboxHost} shares a domain with the app host ${appHost}`,
		remediation: 'Serve kernels from a separate domain (e.g. sandboxes.example.net).',
	};
}

function checkSandboxConfig(env: Env, deps: ApiDeps): CheckOutcome {
	const mode = deps.sandbox.exposure?.mode ?? 'subdomain';
	const backend = computeBackend(env) ?? 'unset';
	const issues: string[] = [];
	if (
		mode === 'subdomain' &&
		['coreweave', 'kubernetes'].includes(backend) &&
		!deps.sandbox.hostname
	) {
		issues.push(
			`MARIMOHUB_COMPUTE_SANDBOX_HOSTNAME is empty (required to build kernel URLs for ${backend})`,
		);
	}
	if (mode === 'proxy' && !deps.sandbox.appBaseUrl) {
		issues.push('MARIMOHUB_APP_BASE_URL is empty (proxy URLs fall back to the request origin)');
	}
	if (!env.MARIMOHUB_COMPUTE_IMAGE && !['local', 'none', 'noop'].includes(backend)) {
		issues.push(
			'MARIMOHUB_COMPUTE_IMAGE is unset (the kernel image, or a comma-separated list of images)',
		);
	}
	if (issues.length === 0) return { status: 'ok', message: `sandbox config OK (${mode} mode)` };
	return {
		status: 'warn',
		message: issues.join('; '),
		remediation: 'See docs/configuration.md#compute.',
	};
}

async function checkWif(deps: ApiDeps): Promise<CheckOutcome> {
	if (!deps.wif) return { status: 'skipped', message: 'WIF disabled' };
	try {
		await deps.wif.issuer.jwks();
		return { status: 'ok', message: 'WIF signing key loads' };
	} catch (err) {
		return {
			status: 'fail',
			fatal: true,
			message: `WIF signing key invalid: ${errMsg(err)}`,
			remediation: 'MARIMOHUB_WIF_SIGNING_KEY must be a PKCS8 PEM RSA private key.',
		};
	}
}

async function checkCompute(env: Env, deps: ApiDeps): Promise<CheckOutcome> {
	const backend = computeBackend(env) ?? 'unset';
	// Optional, duck-typed: adapters may expose a cheap reachability probe. We never
	// invent a heavy vendor call here — if none is exposed, credentials are validated
	// lazily on the first session.
	const probe = (deps.compute as { healthCheck?: () => Promise<void> }).healthCheck;
	if (typeof probe !== 'function') {
		return { status: 'skipped', message: `${backend} backend: validated on first session` };
	}
	try {
		await probe.call(deps.compute);
		return { status: 'ok', message: `${backend} compute reachable` };
	} catch (err) {
		const message = errMsg(err);
		return {
			status: 'fail',
			message: `${backend} compute unreachable: ${message}`,
			remediation: computeRemediation(backend, message),
		};
	}
}

/**
 * Tailor remediation to what `healthCheck()` actually reported: a missing/broken CLI
 * needs an install, whereas a present CLI that can't reach its engine needs the
 * daemon/socket checked. Leading with "install the CLI" for a reachability failure — when
 * the operator already has the CLI — is the misleading guidance this preflight removed.
 */
function computeRemediation(backend: string, message: string): string {
	const cliProblem = /not installed|not on PATH|not executable/i.test(message);
	if (backend === 'docker') {
		return cliProblem
			? 'Install the Docker CLI in the server environment (then mount /var/run/docker.sock or set DOCKER_HOST so it can reach the daemon).'
			: 'Ensure the Docker daemon is running and reachable: mount /var/run/docker.sock or set DOCKER_HOST.';
	}
	if (backend === 'podman') {
		return cliProblem
			? 'Install the Podman CLI in the server environment.'
			: 'Ensure Podman is configured and reachable (rootless storage and cgroups, or the remote connection if using `podman system service`).';
	}
	return 'Check the compute backend credentials and endpoint.';
}

/**
 * Sandbox-native object storage needs a WIF config registered with the Sandbox
 * Gateway; without one, every create that requests object storage fails with
 * CWSANDBOX_RESOURCE_NOT_FOUND. Never above `warn`: the hub serves fine
 * without it, and the deep-health endpoint must not 503 over an auxiliary
 * feature.
 */
async function checkObjectStorageWif(env: Env): Promise<CheckOutcome> {
	const buckets = env.MARIMOHUB_COMPUTE_COREWEAVE_OBJECT_STORAGE_BUCKETS;
	if (computeBackend(env) !== 'coreweave' || !buckets) {
		return { status: 'skipped', message: 'sandbox-native object storage not configured' };
	}
	const base = (env.MARIMOHUB_COMPUTE_COREWEAVE_BASE_URL ?? 'https://api.cwsandbox.com').replace(
		/\/+$/,
		'',
	);
	const url = `${base}/v1beta2/object-storage/wif-config`;
	try {
		const res = await fetchWithTimeout(url, 2500, {
			headers: { Authorization: `Bearer ${env.MARIMOHUB_COMPUTE_COREWEAVE_API_KEY ?? ''}` },
		});
		if (res.status === 404) {
			return {
				status: 'warn',
				message:
					'no WIF config registered with the Sandbox Gateway — sandbox creates that request object storage will fail (CWSANDBOX_RESOURCE_NOT_FOUND)',
				remediation:
					'PUT /v1beta2/object-storage/wif-config; see docs/workload-identity-federation.md (Automatic).',
			};
		}
		if (!res.ok) {
			return { status: 'warn', message: `gateway WIF config probe returned ${res.status}` };
		}
		const body = (await res.json()) as { enabled?: boolean; allowedBuckets?: string[] };
		if (body.enabled === false) {
			return {
				status: 'warn',
				message: 'the gateway WIF config exists but is disabled',
				remediation: 'Re-enable it via PUT /v1beta2/object-storage/wif-config.',
			};
		}
		const allowed = body.allowedBuckets ?? [];
		const denied =
			allowed.length > 0
				? buckets
						.split(',')
						.map((b) => b.trim())
						.filter((b) => b && !allowed.includes(b))
				: [];
		if (denied.length > 0) {
			return {
				status: 'warn',
				message: `bucket(s) missing from the gateway allowlist: ${denied.join(', ')}`,
				remediation: 'Add them to allowedBuckets (an empty allowlist allows all buckets).',
			};
		}
		return { status: 'ok', message: 'gateway WIF config registered and enabled' };
	} catch (err) {
		return { status: 'warn', message: `gateway WIF config probe failed: ${errMsg(err)}` };
	}
}

async function checkAi(deps: ApiDeps): Promise<CheckOutcome> {
	if (!deps.ai) return { status: 'skipped', message: 'managed AI disabled' };
	const url = `${deps.ai.upstreamBaseUrl}/models`;
	try {
		const res = await fetchWithTimeout(url, 2500);
		// 401/403 still proves the upstream is reachable (some providers gate /models).
		if (res.ok || res.status === 401 || res.status === 403) {
			return { status: 'ok', message: `AI upstream reachable (${deps.ai.upstreamBaseUrl})` };
		}
		return {
			status: 'fail',
			message: `AI upstream returned ${res.status} for ${url}`,
			remediation: 'Set MARIMOHUB_AI_UPSTREAM_BASE_URL to the provider /v1 base URL.',
		};
	} catch (err) {
		return {
			status: 'fail',
			message: `AI upstream unreachable: ${errMsg(err)}`,
			remediation: 'Verify MARIMOHUB_AI_UPSTREAM_BASE_URL and network egress to the provider.',
		};
	}
}

async function checkIntegrationSecrets(deps: ApiDeps): Promise<CheckOutcome> {
	const sources = deps.integrations?.secretSources();
	if (!sources) return { status: 'skipped', message: 'integrations disabled' };
	const available = [
		...(sources.inline ? ['inline encryption'] : []),
		...sources.references.map((reference) => reference.backend),
	];
	if (available.length === 0) {
		return {
			status: 'warn',
			message: 'integration secret sources: none',
			remediation:
				'Configure MARIMOHUB_SECRETS_KEK or an external secret resolver before saving secret fields.',
		};
	}
	return {
		status: 'ok',
		message: `integration secret sources: ${available.join(', ')}`,
	};
}

async function checkDataPreview(deps: ApiDeps): Promise<CheckOutcome> {
	if (!deps.dataBrowser?.checkPreview) {
		return { status: 'skipped', message: 'dedicated data-preview runtime disabled' };
	}
	try {
		await deps.dataBrowser.checkPreview();
		return { status: 'ok', message: 'data-preview runtime is ready' };
	} catch (err) {
		return {
			status: 'fail',
			message: `Data-preview runtime unavailable: ${errMsg(err)}`,
			remediation:
				'Check DuckDB-Wasm runtime support or compute credentials and capacity; for sandbox previews, verify MARIMOHUB_DATA_PREVIEW_IMAGE provides Python, PyIceberg, and PyArrow.',
		};
	}
}

const DATA_PREVIEW_PREFLIGHT_TIMEOUT_MS = 30_000;

export function buildPreflightChecks(env: Env, deps: ApiDeps): PreflightCheck[] {
	const checks: PreflightCheck[] = [
		{ name: 'storage', run: () => checkStorage(env, deps) },
		{ name: 'auth.oidc-discovery', run: () => checkAuth(env) },
		{ name: 'sandbox.isolation', run: async () => checkIsolation(env, deps) },
		{ name: 'sandbox.config', run: async () => checkSandboxConfig(env, deps) },
		{ name: 'compute', run: () => checkCompute(env, deps) },
		{ name: 'compute.object-storage-wif', run: () => checkObjectStorageWif(env) },
	];
	if (deps.wif) checks.push({ name: 'wif', run: () => checkWif(deps) });
	if (deps.ai) checks.push({ name: 'ai.upstream', run: () => checkAi(deps) });
	if (deps.integrations) {
		checks.push({ name: 'integrations.secrets', run: () => checkIntegrationSecrets(deps) });
	}
	if (deps.dataBrowser?.checkPreview) {
		checks.push({
			name: 'integrations.data-preview',
			run: () => checkDataPreview(deps),
			timeoutMs: DATA_PREVIEW_PREFLIGHT_TIMEOUT_MS,
		});
	}
	return checks;
}
