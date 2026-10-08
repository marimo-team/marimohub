import { z } from 'zod';
import { ValidationError } from '../../../errors';
import { AWS_REGION_NAME_REGEX, awsDnsSuffix } from '../../../ports/packageRegistry';
import { awsStaticCredentials } from './common';
import { defaultIndexField, definePythonIndex } from './pythonPackageIndexes';

const configSchema = z.strictObject({
	domain: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,48}[a-z0-9]$/)
		.describe('CodeArtifact domain name'),
	domain_owner: z
		.string()
		.regex(/^\d{12}$/)
		.describe('AWS account ID that owns the domain'),
	repository: z
		.string()
		.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/)
		.describe('CodeArtifact repository name'),
	region: z
		.string()
		.regex(AWS_REGION_NAME_REGEX)
		.default('us-east-1')
		.describe('AWS region of the domain, for example us-east-1'),
	auth: z
		.discriminatedUnion('method', [
			z
				.strictObject({ method: z.literal('ambient') })
				.describe(
					"Exchange the project's workload identity for AWS credentials on the hub, then mint a token",
				),
			z
				.strictObject({ method: z.literal('static'), ...awsStaticCredentials })
				.describe('Mint a token on the hub with these AWS keys; the keys never enter the sandbox'),
		])
		.describe(
			"How the hub gets AWS credentials to mint the CodeArtifact token: `ambient` uses the project's " +
				'workload identity (WIF), `static` uses the AWS keys below. Neither reaches the sandbox.',
		),
	default_index: defaultIndexField(),
});

type CodeArtifactConfig = z.infer<typeof configSchema>;

function indexUrl(config: CodeArtifactConfig): string {
	return `https://${config.domain}-${config.domain_owner}.d.codeartifact.${config.region}.${awsDnsSuffix(config.region)}/pypi/${config.repository}/simple/`;
}

export const codeArtifact = definePythonIndex({
	kind: 'aws_codeartifact',
	title: 'AWS CodeArtifact',
	description:
		'Install private Python packages with uv. The hub mints a 12-hour CodeArtifact token for each new session or job; restart the session after the token expires.',
	brand: { color: '#FF9900' },
	configSchema,
	uiHints: {
		domain: { group: 'Repository', order: 1 },
		domain_owner: { group: 'Repository', order: 2 },
		repository: { group: 'Repository', order: 3 },
		region: { group: 'Repository', order: 4 },
		'auth.access_key_id': { widget: 'password' },
		'auth.secret_access_key': { widget: 'password' },
		'auth.session_token': { widget: 'password' },
	},
	packageRegistry: {
		source: (config) => ({
			provider: 'aws_codeartifact',
			domain: config.domain,
			domain_owner: config.domain_owner,
			repository: config.repository,
			region: config.region,
			auth: config.auth,
		}),
	},
	connection(config, { packageRegistryCredentials }) {
		if (!packageRegistryCredentials) {
			throw new ValidationError('CodeArtifact credentials are unavailable.');
		}
		return { url: indexUrl(config), credentials: packageRegistryCredentials };
	},
});
