/**
 * Workload-identity federation glue: mint a project-scoped JWT, exchange it for
 * temporary credentials, and map them onto the S3 env a sandbox needs to reach a
 * federated bucket — no long-lived key. Keeps the subject convention and the
 * mint → exchange → env-map pipeline in one place.
 */
import type { ProjectId } from '../../ids';
import type { FederationTarget, TempS3Creds } from '../../ports/credentialBroker';
import type { WorkloadRef } from '../../ports/integrations';
import { s3CredsToEnv } from './s3CredsEnv';
import type { WorkloadIdentityIssuer } from './WorkloadIdentityIssuer';

/**
 * The federated subject for a project, used verbatim as the cloud principal
 * `role/<issuer>:<projectId>`. The project id already carries a `proj-` prefix,
 * so no extra namespace is added (a future user/notebook subject would use its
 * own `user_`/`nb-` prefix).
 */
export function projectSubject(projectId: ProjectId): string {
	return projectId;
}

/**
 * Mint a project-scoped JWT, exchange it via the target's broker, and map the
 * temporary credentials onto S3 env vars to inject into a sandbox. Throws on
 * mint/exchange failure — the caller decides how to handle it (the session
 * route treats it as non-fatal so a federation gap never blocks a kernel).
 */
export async function exchangeFederatedStorageEnv(
	issuer: WorkloadIdentityIssuer,
	issuerUrl: string,
	target: FederationTarget,
	projectId: ProjectId,
	workload: WorkloadRef,
): Promise<Record<string, string>> {
	const creds = await exchangeFederatedStorageCredentials(
		issuer,
		issuerUrl,
		target,
		projectId,
		workload,
	);
	return s3CredsToEnv(creds, target.storage.endpoint, target.storage.region);
}

export async function exchangeFederatedStorageCredentials(
	issuer: WorkloadIdentityIssuer,
	issuerUrl: string,
	target: FederationTarget,
	projectId: ProjectId,
	workload: WorkloadRef,
): Promise<TempS3Creds> {
	const jwt = await issuer.mint({
		iss: issuerUrl,
		sub: projectSubject(projectId),
		aud: target.audience,
		extraClaims: {
			project_id: projectId,
			workload_kind: workload.kind,
			workload_id: workload.id,
		},
	});
	return target.broker.exchange(jwt);
}
