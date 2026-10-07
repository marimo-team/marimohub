import type { TempS3Creds } from './credentialBroker';
import type { IntegrationProbe } from './integrations';

/**
 * A full AWS region name, strict enough to interpolate into a hostname. Partition
 * prefixes are not always two letters (`eusc-de-east-1`).
 */
export const AWS_REGION_NAME_REGEX = /^[a-z]+(?:-[a-z]+)+-\d+$/;

/** AWS China regions live in a separate partition with its own DNS suffix. */
export function awsDnsSuffix(region: string): string {
	return region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
}

export interface CodeArtifactSource {
	provider: 'aws_codeartifact';
	domain: string;
	domain_owner: string;
	repository: string;
	region: string;
	auth:
		| { method: 'ambient' }
		| {
				method: 'static';
				access_key_id: string;
				secret_access_key: string;
				session_token?: string;
		  };
}

export type PackageRegistrySource = CodeArtifactSource;

export interface PackageRegistryCredentials {
	username: string;
	password: string;
	expiresAt?: string;
}

export interface PackageRegistryCredentialProvider {
	resolve(
		source: PackageRegistrySource,
		options: {
			probe: IntegrationProbe;
			/** The project's workload-identity credentials, present only for `ambient` auth. */
			federatedCredentials?: TempS3Creds;
			signal?: AbortSignal;
		},
	): Promise<PackageRegistryCredentials>;
}
