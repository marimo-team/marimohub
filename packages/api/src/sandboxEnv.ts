import {
	AWS_CONTAINER_CREDENTIAL_ENV,
	containerCredentialsEnv,
	exchangeFederatedStorageCredentials,
	mintWifCredentialsToken,
	projectSessionEnv,
	s3CredsToEnv,
	STATIC_AWS_CREDENTIAL_ENV,
	UnavailableError,
	ValidationError,
	WEB_IDENTITY_AWS_CREDENTIAL_ENV,
	wifCredentialsSubject,
} from '@marimo-hub/core';
import type {
	AuthenticatedPrincipal,
	Project,
	ProjectId,
	SessionEnv,
	SessionRender,
	TempS3Creds,
	UserId,
	WorkloadRef,
} from '@marimo-hub/core';
import type { JobRunContext } from '@marimo-hub/core/jobs';
import { federationFor } from './federation';
import type { ApiDeps } from './context';
import { errorMetadata, logEvent } from './log';
import { wifCredentialCacheFor } from './wifCredentialCache';

export function mergeSessionEnv(base: SessionEnv | undefined, add: SessionEnv): SessionEnv {
	return {
		files: [...(base?.files ?? []), ...(add.files ?? [])],
		vars: { ...base?.vars, ...add.vars },
		defaults: { ...base?.defaults, ...add.defaults },
	};
}

const ENDPOINT_DELIVERY_OWNED_ENV = [
	...STATIC_AWS_CREDENTIAL_ENV,
	...AWS_CONTAINER_CREDENTIAL_ENV,
	...WEB_IDENTITY_AWS_CREDENTIAL_ENV,
];

// Integrations are the base; WIF and marimo config win collisions.
export function composeSessionEnv(layers: {
	wifVars?: Record<string, string>;
	endpointDelivery?: boolean;
	marimoEnv?: SessionEnv;
	integrationEnv?: SessionRender;
}): SessionEnv | undefined {
	let env: SessionEnv | undefined = layers.wifVars ? { vars: layers.wifVars } : undefined;
	if (layers.marimoEnv) env = mergeSessionEnv(env, layers.marimoEnv);
	if (layers.integrationEnv) {
		env = mergeSessionEnv(projectSessionEnv(layers.integrationEnv), env ?? {});
	}
	// Static keys, web-identity inputs, and other container-provider inputs must not bypass
	// or redirect endpoint delivery, even if token minting failed.
	if (env && layers.endpointDelivery) {
		for (const name of ENDPOINT_DELIVERY_OWNED_ENV) {
			if (layers.wifVars?.[name] === undefined) delete env.vars?.[name];
			delete env.defaults?.[name];
		}
	}
	return env;
}

export type FederatedCredentials = () => Promise<TempS3Creds>;

/**
 * One lazy, memoized WIF exchange per workload so the storage env and package
 * registry token minting share a single JWT and STS round trip.
 */
export function federatedCredentialsFor(
	deps: Partial<Pick<ApiDeps, 'wif'>>,
	project: Project,
	workload: WorkloadRef,
	options: { restricted?: boolean } = {},
): FederatedCredentials | undefined {
	const wif = federationFor(project, deps.wif, options);
	if (!wif) return;
	let exchange: Promise<TempS3Creds> | undefined;
	return () =>
		(exchange ??= exchangeFederatedStorageCredentials(
			wif.issuer,
			wif.issuerUrl,
			wif.target,
			project.id,
			workload,
		));
}

export interface FederatedVarsOptions {
	project: Project;
	workload: WorkloadRef;
	/** True for a viewer's throwaway sandbox: never federated credentials. */
	restricted: boolean;
	/** Shares the exchange with {@link resolveIntegrationRender}; built per call when absent. */
	federatedCredentials?: FederatedCredentials;
	credentialsEndpoint?: { url: string; principal: AuthenticatedPrincipal; expiresAt: string };
	onError?: (err: unknown) => void;
}

/**
 * WIF: best-effort project-scoped federated S3 creds. A federation/policy gap
 * yields no creds, never a failed sandbox. The JWT and creds are never logged.
 */
export async function resolveFederatedVars(
	deps: Pick<ApiDeps, 'wif'>,
	options: FederatedVarsOptions,
): Promise<Record<string, string> | undefined> {
	const wif = federationFor(options.project, deps.wif, { restricted: options.restricted });
	if (!wif) return;
	const endpoint = options.credentialsEndpoint;
	try {
		if (wif.credentialsEndpoint && endpoint && options.workload.kind === 'session') {
			const sessionId = options.workload.id;
			const token = await mintWifCredentialsToken(
				wif.credentialsEndpoint.keyMaterial,
				{
					sessionId,
					projectId: options.project.id,
					userId: endpoint.principal.id,
					subject: wifCredentialsSubject(endpoint.principal),
				},
				{ expiresAt: endpoint.expiresAt },
			);
			const credentials =
				options.federatedCredentials ??
				federatedCredentialsFor(deps, options.project, options.workload);
			// SDK container providers time out after 1-2 s, so the first fetch must not wait on STS.
			if (credentials) {
				wifCredentialCacheFor(wif)
					.get(sessionId, credentials)
					.catch((err: unknown) =>
						logEvent({
							level: 'debug',
							event: 'wif_credentials_prime_failed',
							project_id: options.project.id,
							session_id: sessionId,
							...errorMetadata(err),
						}),
					);
			}
			return containerCredentialsEnv(
				endpoint.url,
				token,
				wif.target.storage.endpoint,
				wif.target.storage.region,
			);
		}
		const credentials =
			options.federatedCredentials ??
			federatedCredentialsFor(deps, options.project, options.workload, options);
		if (!credentials) return;
		return s3CredsToEnv(
			await credentials(),
			wif.target.storage.endpoint,
			wif.target.storage.region,
		);
	} catch (err) {
		options.onError?.(err);
		return;
	}
}

export interface IntegrationRenderOptions {
	project?: Project;
	projectId: ProjectId;
	workload: WorkloadRef;
	principal: { userId: UserId; email: string };
	restricted: boolean;
	/** Shares the exchange with {@link resolveFederatedVars}; built per call when absent. */
	federatedCredentials?: FederatedCredentials;
	onRendered?: (render: SessionRender) => void;
	onError?: (err: unknown) => void;
}

/**
 * Integrations FAIL CLOSED — a configured data source is load-bearing, so a
 * render failure aborts provisioning rather than starting a sandbox with
 * partial config. Only curated validation and unavailability errors are safe
 * to return to a caller.
 */
export async function resolveIntegrationRender(
	deps: Pick<ApiDeps, 'integrations'> & Partial<Pick<ApiDeps, 'wif'>>,
	options: IntegrationRenderOptions,
): Promise<SessionRender | undefined> {
	if (!(deps.integrations && !options.restricted)) return;
	try {
		const resolveFederatedCredentials =
			options.federatedCredentials ??
			(options.project
				? federatedCredentialsFor(deps, options.project, options.workload)
				: undefined);
		const render = await deps.integrations.resolveForSession(options.projectId, {
			workload: options.workload,
			principal: options.principal,
			...(resolveFederatedCredentials ? { resolveFederatedCredentials } : {}),
		});
		if (render) options.onRendered?.(render);
		return render;
	} catch (err) {
		options.onError?.(err);
		if (err instanceof ValidationError || err instanceof UnavailableError) throw err;
		throw new UnavailableError(
			'integration_render_failed: could not render this project’s integrations',
		);
	}
}

/**
 * The job runner's env: the same two layers an app session gets, attributed to
 * the run and to the principal the run acts for (the manual triggerer, else
 * the job's author). Integrations stay the lower-precedence base.
 */
export async function resolveJobSandboxEnv(
	deps: Pick<ApiDeps, 'wif' | 'integrations' | 'services'>,
	context: JobRunContext,
): Promise<SessionEnv | undefined> {
	const { run, job, project } = context;
	const userId = run.triggered_by ?? job.created_by;
	const identity = await deps.services.identities.get(userId).catch(() => null);
	const fields = { project_id: run.project_id, job_id: run.job_id, run_id: run.run_id };
	const workload: WorkloadRef = { kind: 'job-run', id: run.run_id };
	const federatedCredentials = federatedCredentialsFor(deps, project, workload);
	const [wifVars, render] = await Promise.all([
		resolveFederatedVars(deps, {
			project,
			workload,
			restricted: false,
			federatedCredentials,
			onError: (err) =>
				logEvent({
					level: 'warn',
					event: 'job_wif_exchange_failed',
					...fields,
					...errorMetadata(err),
				}),
		}),
		resolveIntegrationRender(deps, {
			projectId: project.id,
			project,
			workload,
			federatedCredentials,
			principal: { userId, email: identity?.email ?? '' },
			restricted: false,
			onRendered: (rendered) => {
				if (rendered.warnings.length > 0) {
					logEvent({
						level: 'warn',
						event: 'job_integration_warnings',
						...fields,
						integration_warning_count: rendered.warnings.length,
					});
				}
			},
			onError: (err) =>
				logEvent({
					level: 'error',
					event: 'job_integration_render_failed',
					...fields,
					...errorMetadata(err),
				}),
		}),
	]);
	return composeSessionEnv({ wifVars, integrationEnv: render });
}
