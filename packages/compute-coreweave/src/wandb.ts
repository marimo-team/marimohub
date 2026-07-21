/**
 * W&B Sandboxes — the CoreWeave Sandbox backend behind the W&B gateway.
 *
 * Same gRPC API and endpoint as the direct CoreWeave path; only auth differs.
 * Instead of a CoreWeave API key, the gateway authenticates via gRPC metadata
 * (`x-wandb-api-key` + optional entity/project headers). Presence of `metadata`
 * on the SDK transport suppresses its `authorization` header entirely, so the
 * W&B key is the sole credential sent.
 *
 * The upstream SDK ships this as the pruned `/wandb` entrypoint (see
 * `vendor/cwsandbox/UPSTREAM.md`); we assemble the same headers locally against
 * the vendored `/node` transport rather than re-vendoring. The netrc fallback is
 * deliberately omitted — server config is env-driven.
 *
 * The config surface is a restricted subset of `CoreWeaveConfig`: the W&B
 * gateway does not support profile/placement overrides, GPU resource requests,
 * or non-default egress modes, and CAIOS object-storage vending is unconfirmed
 * through it. Use hub-minted WIF for bucket access on this backend.
 *
 * Kernel URLs: the W&B managed runner assigns each public-ingress sandbox a
 * per-sandbox public IP (`serviceAddress`, plain HTTP) instead of a hostname
 * scheme, so this backend resolves URLs via `resolveExposedUrl` and ignores
 * the hostname-template machinery (verified live 2026-07-21).
 */
import { SandboxClient } from '@coreweave/cwsandbox';
import type { SandboxId as CwSandboxId } from '@coreweave/cwsandbox';
import { DEFAULT_BASE_URL, GrpcSandboxTransport } from '@coreweave/cwsandbox/node';
import { CoreWeaveCompute } from './index';
import type { CoreWeaveClient, CoreWeaveConfig } from './index';

/**
 * Version reported in the gateway telemetry headers. The vendored SDK build's
 * package version is literally `0.0.0` (see `vendor/cwsandbox/UPSTREAM.md` for
 * the pinned upstream commit), so this is the truthful client version.
 */
const VENDORED_SDK_VERSION = '0.0.0';

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

/** gRPC metadata the W&B sandbox gateway authenticates with. */
export function buildWandbMetadata(
	config: Pick<WandbConfig, 'apiKey' | 'entity' | 'project'>,
): Readonly<Record<string, string>> {
	// Trim like the upstream wrapper: a stray trailing newline (a common
	// secret-file artifact) is an illegal gRPC metadata value that fails
	// cryptically at the first call.
	const entity = config.entity?.trim();
	const project = config.project?.trim();
	return {
		'x-wandb-api-key': config.apiKey.trim(),
		...(entity ? { 'x-entity-id': entity } : {}),
		...(project ? { 'x-project-name': project } : {}),
		'x-cwsandbox-client-version': VENDORED_SDK_VERSION,
		'x-wandb-sdk-version': VENDORED_SDK_VERSION,
		// Keep the upstream SDK's integration marker: we ARE a (vendored) build of
		// the JS SDK, and a custom value risks a gateway-side allowlist rejection.
		'x-sandbox-integration': 'js-sdk',
	};
}

/**
 * Build a `resolveExposedUrl` from a sandbox-metadata lookup. The W&B managed
 * runner does not serve sandboxes under a hostname scheme — each public-ingress
 * sandbox gets a per-sandbox public IP (`serviceAddress`), plain HTTP.
 */
export function serviceAddressResolver(
	get: (sandboxId: string) => Promise<{ serviceAddress?: string }>,
): (sandboxId: string, port: number) => Promise<string> {
	return async (sandboxId, port) => {
		const { serviceAddress } = await get(sandboxId);
		if (!serviceAddress) {
			throw new Error(
				`W&B sandbox ${sandboxId} has no serviceAddress (public ingress not assigned yet?)`,
			);
		}
		return `http://${serviceAddress}:${port}`;
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

	const transport = new GrpcSandboxTransport({
		// `||` (not `??`): a set-but-empty env var must also fall back.
		baseUrl: baseUrl?.trim() || DEFAULT_BASE_URL,
		metadata: buildWandbMetadata({ apiKey, entity, project }),
	});
	return new CoreWeaveCompute(
		{
			...coreweave,
			resolveExposedUrl: serviceAddressResolver((sandboxId) =>
				transport.get({ sandboxId: sandboxId }),
			),
		},
		// Same controlled cast as `CoreWeaveCompute.getClient()`: the SDK client
		// exposes the CoreWeaveClient surface at runtime. Eager construction is
		// safe — grpc-js channels dial lazily.
		new SandboxClient({ transport }) as unknown as CoreWeaveClient,
	);
}
