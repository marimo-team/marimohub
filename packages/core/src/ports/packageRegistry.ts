import type { TempS3Creds } from './credentialBroker';
import type { IntegrationProbe } from './integrations';

export interface CodeArtifactSource {
	provider: 'aws_codeartifact';
	domain: string;
	domain_owner: string;
	repository: string;
	region: string;
	duration_seconds: number;
	auth:
		| { method: 'token'; token: string }
		| { method: 'federation' }
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
			awsCredentials?: TempS3Creds;
			signal?: AbortSignal;
		},
	): Promise<PackageRegistryCredentials>;
}
