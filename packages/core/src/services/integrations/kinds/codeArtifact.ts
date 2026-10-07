import { z } from 'zod';
import { ValidationError } from '../../../errors';
import type { CodeArtifactSource } from '../../../ports/packageRegistry';
import { defineIntegration, envSegment } from '../sdk';
import { zSecret } from '../secretFields';

const configSchema = z.strictObject({
	domain: z.string().regex(/^[a-z][a-z0-9-]{0,48}[a-z0-9]$/),
	domain_owner: z
		.string()
		.regex(/^\d{12}$/)
		.describe('AWS account ID that owns the domain'),
	repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/),
	region: z
		.string()
		.regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
		.default('us-east-1'),
	default_index: z.boolean().default(false).describe('Replace public PyPI with this repository'),
	duration_seconds: z
		.number()
		.int()
		.min(900)
		.max(43200)
		.default(43200)
		.describe('Token lifetime in seconds. Restart the session after expiry.'),
	auth: z.discriminatedUnion('method', [
		z.strictObject({ method: z.literal('federation') }).describe('Project AWS workload identity'),
		z
			.strictObject({
				method: z.literal('static'),
				access_key_id: zSecret(),
				secret_access_key: zSecret(),
				session_token: zSecret().optional(),
			})
			.describe('AWS credentials'),
		z
			.strictObject({ method: z.literal('token'), token: zSecret() })
			.describe('Existing CodeArtifact token'),
	]),
});

function indexUrl(
	config: Pick<CodeArtifactSource, 'domain' | 'domain_owner' | 'repository' | 'region'>,
): string {
	const suffix = config.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
	return `https://${config.domain}-${config.domain_owner}.d.codeartifact.${config.region}.${suffix}/pypi/${config.repository}/simple/`;
}

export const codeArtifact = defineIntegration({
	kind: 'aws_codeartifact',
	title: 'AWS CodeArtifact',
	description:
		'Install private Python packages with uv. AWS authentication creates a token for each new session or job; restart after expiry.',
	category: 'package_registry',
	brand: { color: '#FF9900' },
	schemaVersion: 1,
	configSchema,
	uiHints: {
		domain: { group: 'Repository', order: 1 },
		domain_owner: { group: 'Repository', order: 2 },
		repository: { group: 'Repository', order: 3 },
		region: { group: 'Repository', order: 4 },
		auth: { group: 'Authentication', order: 10 },
		default_index: { group: 'Package resolution', order: 20 },
		duration_seconds: { group: 'Authentication', order: 11, advanced: true },
	},
	packageRegistry: {
		source: (config) => ({ provider: 'aws_codeartifact', ...config }),
		indexUrl,
	},
	render({ config, instanceName, packageRegistryCredentials }) {
		const credentials =
			packageRegistryCredentials ??
			(config.auth.method === 'token'
				? { username: 'aws', password: config.auth.token }
				: undefined);
		if (!credentials) throw new ValidationError('CodeArtifact credentials are unavailable.');
		const segment = envSegment(instanceName);
		return {
			packageIndexes: [
				{ name: instanceName, url: indexUrl(config), default: config.default_index },
			],
			env: {
				[`UV_INDEX_${segment}_USERNAME`]: credentials.username,
				[`UV_INDEX_${segment}_PASSWORD`]: credentials.password,
			},
			manifestExtra: credentials.expiresAt ? { credentials_expire_at: credentials.expiresAt } : {},
		};
	},
});
