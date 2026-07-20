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
import type { Env } from './env';
import { checkSandboxHostIsolation } from './hostIsolation';

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

async function checkStorage(env: Env, deps: ApiDeps): Promise<CheckOutcome> {
	const backend = env.MARIMOHUB_STORAGE_BACKEND ?? 's3';
	const bucket = deps.bucket as { verifyConditionalWrites?: () => Promise<void> };
	if (typeof bucket.verifyConditionalWrites !== 'function') {
		return { status: 'skipped', message: `${backend} backend: no conditional-write probe` };
	}
	try {
		await bucket.verifyConditionalWrites();
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
				remediation: 'Use AWS S3, Cloudflare R2, or a recent MinIO that enforces If-Match.',
			};
		}
		return {
			status: 'fail',
			message: `Could not verify storage: ${message}`,
			remediation: 'Check the bucket name, endpoint, region, and credentials.',
		};
	}
}

async function checkAuth(env: Env): Promise<CheckOutcome> {
	const backend = env.MARIMOHUB_AUTH_BACKEND;
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
	const backend = env.MARIMOHUB_COMPUTE_BACKEND ?? 'unset';
	const issues: string[] = [];
	if (
		mode === 'subdomain' &&
		(backend === 'coreweave' || backend === 'kubernetes') &&
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
	const backend = env.MARIMOHUB_COMPUTE_BACKEND ?? 'unset';
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
		return {
			status: 'fail',
			message: `${backend} compute unreachable: ${errMsg(err)}`,
			remediation: 'Check the compute backend credentials and endpoint.',
		};
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

async function checkSecrets(env: Env, deps: ApiDeps): Promise<CheckOutcome> {
	if (!deps.secrets) return { status: 'skipped', message: 'project secrets disabled' };
	const awsEnabled =
		Boolean(env.MARIMOHUB_SECRETS_AWS_REGION) || env.MARIMOHUB_SECRETS_AWS === 'true';
	const backends = awsEnabled ? 'bucket + aws-sm' : 'bucket';
	return { status: 'ok', message: `project secrets enabled (${backends})` };
}

export function buildPreflightChecks(env: Env, deps: ApiDeps): PreflightCheck[] {
	const checks: PreflightCheck[] = [
		{ name: 'storage', run: () => checkStorage(env, deps) },
		{ name: 'auth.oidc-discovery', run: () => checkAuth(env) },
		{ name: 'sandbox.isolation', run: async () => checkIsolation(env, deps) },
		{ name: 'sandbox.config', run: async () => checkSandboxConfig(env, deps) },
		{ name: 'compute', run: () => checkCompute(env, deps) },
	];
	if (deps.wif) checks.push({ name: 'wif', run: () => checkWif(deps) });
	if (deps.ai) checks.push({ name: 'ai.upstream', run: () => checkAi(deps) });
	if (deps.secrets) checks.push({ name: 'secrets', run: () => checkSecrets(env, deps) });
	return checks;
}
