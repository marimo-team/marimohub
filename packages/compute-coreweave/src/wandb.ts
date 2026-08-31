/**
 * W&B Sandboxes — the CoreWeave Sandbox backend behind the W&B gateway.
 *
 * Same gRPC API and endpoint as the direct CoreWeave path; only auth differs.
 * Instead of a CoreWeave API key, the gateway authenticates via gRPC metadata
 * (`x-wandb-api-key` + optional entity/project headers), assembled by the
 * SDK's `/wandb` entrypoint. `env: {}` disables its ambient `WANDB_*`/netrc
 * fallbacks — server config flows through our config layer only — and a
 * blank key is rejected here rather than silently falling back to `~/.netrc`.
 *
 * The config surface is a restricted subset of `CoreWeaveConfig`: the W&B
 * gateway does not support GPU resource requests, and CAIOS object-storage
 * vending is unconfirmed through it. Use hub-minted WIF for bucket access.
 *
 * Kernel URLs: the W&B managed runner has no static hostname scheme, so this
 * backend ignores the hostname-template machinery and resolves URLs at expose
 * time from `serviceUrls`. The handle's metadata — refreshed by the boot
 * `wait()` — usually already carries them, so the common path costs no extra
 * Get round-trip.
 * INTEGRATION SURFACE: the exact `serviceUrls` contents from the W&B gateway
 * are unverified against a live W&B sandbox.
 */
import type { GetSandboxResult, ServiceUrl } from '@coreweave/cwsandbox';
import { createSandboxClient, DEFAULT_WANDB_SANDBOX_BASE_URL } from '@coreweave/cwsandbox/wandb';
import { CoreWeaveCompute } from './index';
import type { CoreWeaveClient, CoreWeaveConfig, CoreWeaveSandbox } from './index';
import { instrumentCoreWeaveClient } from './tracing';

/**
 * The gateway-supported subset of `CoreWeaveConfig` plus W&B credentials. The
 * `Pick` fields pass through to the CoreWeave adapter unchanged (docs on
 * `CoreWeaveConfig`); everything else there is intentionally unavailable here.
 */
export interface WandbConfig extends Pick<
	CoreWeaveConfig,
	'image' | 'kernelPort' | 'ownerTag' | 'maxLifetimeSeconds'
> {
	/** W&B API key (`WANDB_API_KEY`; from wandb.ai user settings). */
	apiKey: string;
	/** W&B entity (team/user) to attribute sandboxes to (`x-entity-id`). */
	entity?: string;
	/** W&B project to attribute sandboxes to (`x-project-name`). */
	project?: string;
	/** Sandbox gateway URL; defaults to the shared CoreWeave endpoint. */
	baseUrl?: string;
}

/**
 * Build a `resolveExposedUrl` from the sandbox handle plus a metadata lookup.
 * The handle's `serviceUrls` (kept fresh by the SDK's create/wait/reconnect
 * Gets) answer without a round-trip; the lookup covers a URL assigned only
 * after the handle's last refresh.
 */
export function serviceUrlResolver(
	get: (sandboxId: string) => Promise<Pick<GetSandboxResult, 'serviceUrls'>>,
): (sandbox: CoreWeaveSandbox, port: number) => Promise<string> {
	const match = (serviceUrls: readonly ServiceUrl[] | undefined, port: number) =>
		serviceUrls?.find((s) => s.port === port);
	return async (sandbox, port) => {
		const cached = match(sandbox.serviceUrls, port);
		if (cached) return cached.url;
		const fetched = match((await get(sandbox.sandboxId)).serviceUrls, port);
		if (!fetched) {
			throw new Error(
				`W&B sandbox ${sandbox.sandboxId} reports no service URL for port ${port} ` +
					'(public ingress not assigned yet?)',
			);
		}
		return fetched.url;
	};
}

/**
 * A `SandboxProvider` for W&B sandboxes: `CoreWeaveCompute` composed with a
 * W&B-gateway-authenticated client and per-sandbox URL resolution. The optional
 * `client` preserves the same test-injection seam as the CoreWeave constructor
 * (URL resolution then falls back to the hostname template).
 */
export function createWandbCompute(
	config: WandbConfig,
	client?: CoreWeaveClient,
): CoreWeaveCompute {
	const { apiKey, entity, project, baseUrl, ...coreweave } = config;
	if (client) return new CoreWeaveCompute(coreweave, client);

	// Reject a blank key up front (a stray trailing newline is a common
	// secret-file artifact); with `env: {}` the SDK would otherwise fall
	// through to the netrc lookup.
	if (!apiKey.trim()) {
		throw new Error('W&B API key is missing or blank');
	}
	// Normalize once so the SDK and the tracing endpoint label agree (the SDK
	// would trim/default internally, but only for its own use). Eager
	// construction is safe — grpc-js channels dial lazily.
	const gatewayUrl = baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_WANDB_SANDBOX_BASE_URL;
	const sdk = createSandboxClient({
		apiKey: apiKey.trim(),
		entity,
		project,
		baseUrl: gatewayUrl,
		env: {},
	});
	// Same controlled cast as `CoreWeaveCompute.getClient()`: the SDK client
	// exposes the CoreWeaveClient surface at runtime.
	// oxlint-disable-next-line anti-slop/no-chained-type-assertions
	const instrumented = instrumentCoreWeaveClient(sdk as unknown as CoreWeaveClient, gatewayUrl);
	return new CoreWeaveCompute(
		{
			...coreweave,
			// The fallback lookup rides the instrumented client (`fromId` = one
			// traced Get) so no gateway request escapes tracing.
			resolveExposedUrl: serviceUrlResolver((sandboxId) => instrumented.fromId(sandboxId)),
		},
		instrumented,
	);
}
