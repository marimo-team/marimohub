import { z } from 'zod';
import { ValidationError } from '../../../errors';
import { hasControlCharacter } from '../../../internal/validation';
import type { PackageRegistryCredentials } from '../../../ports/packageRegistry';
import { basicAuthHeader, defineIntegration, envSegment } from '../sdk';
import type { IntegrationDefinition } from '../sdk';
import { zSecret } from '../secretFields';
import { serviceUrl, serviceUrlField } from './common';

const indexUrlField = () =>
	serviceUrlField()
		.regex(/^https:/, 'Package indexes must use HTTPS')
		.regex(/^[^\\]+$/, 'URLs must not contain backslashes')
		.refine((value) => !hasControlCharacter(value), 'URLs must not contain control characters');

const usernameField = () =>
	z
		.string()
		.regex(/^[^:]*$/, 'Username must not contain colons')
		.refine((value) => !hasControlCharacter(value), 'Username must not contain control characters');

const basicAuth = z.strictObject({
	method: z.literal('basic'),
	username: usernameField(),
	password: zSecret().describe('Password or access token'),
});
const tokenAuth = z.strictObject({ method: z.literal('token'), token: zSecret() });
const defaultIndex = z
	.boolean()
	.default(false)
	.describe('Replace public PyPI with this repository');
const pathSegment = () =>
	z
		.string()
		.min(1)
		.regex(/^[^/\\?#%]+$/)
		.refine((value) => !hasControlCharacter(value), 'Must not contain control characters')
		.refine((value) => value !== '.' && value !== '..', 'Must not be a relative path');

interface IndexConnection {
	url: string;
	credentials?: PackageRegistryCredentials;
}

function validateConnection({ url, credentials }: IndexConnection): void {
	if (!indexUrlField().safeParse(url).success)
		throw new ValidationError('Invalid package index URL.');
	if (!credentials) return;
	if (!usernameField().safeParse(credentials.username).success) {
		throw new ValidationError('Invalid package index username.');
	}
	if (hasControlCharacter(credentials.password)) {
		throw new ValidationError('Package index credentials must not contain control characters.');
	}
}

function definePythonIndex<S extends z.ZodType<{ default_index: boolean }>>(
	definition: Pick<
		IntegrationDefinition<S>,
		'kind' | 'title' | 'description' | 'brand' | 'configSchema' | 'uiHints'
	> & {
		connection(config: z.infer<S>): IndexConnection;
	},
): IntegrationDefinition<S> {
	const { connection, ...metadata } = definition;
	function resolve(config: z.infer<S>): IndexConnection {
		const result = connection(config);
		validateConnection(result);
		return result;
	}
	return defineIntegration({
		...metadata,
		category: 'package_registry',
		schemaVersion: 1,
		uiHints: {
			...metadata.uiHints,
			auth: { group: 'Authentication', order: 10 },
			default_index: { group: 'Package resolution', order: 20 },
		},
		render({ config, instanceName }) {
			const { url, credentials } = resolve(config);
			const segment = envSegment(instanceName);
			return {
				packageIndexes: [{ name: instanceName, url, default: config.default_index }],
				env: credentials
					? {
							[`UV_INDEX_${segment}_USERNAME`]: credentials.username,
							[`UV_INDEX_${segment}_PASSWORD`]: credentials.password,
						}
					: {},
			};
		},
		async testConnection(config, probe, options) {
			const { url, credentials } = resolve(config);
			const signal = options?.signal;
			signal?.throwIfAborted();
			const response = await probe.fetch(url, {
				headers: credentials
					? { Authorization: basicAuthHeader(credentials.username, credentials.password) }
					: {},
				signal,
			});
			signal?.throwIfAborted();
			return {
				ok: response.ok,
				details: response.ok
					? 'Repository is accessible.'
					: 'Repository access failed. Check the URL, credentials, and package read permissions.',
			};
		},
	});
}

export const pythonPackageIndex = definePythonIndex({
	kind: 'python_package_index',
	title: 'Python package index',
	description:
		'Install Python packages from a custom HTTPS index with optional username and password authentication.',
	brand: { color: '#3776AB' },
	configSchema: z.strictObject({
		url: indexUrlField().describe('Full Python simple-index URL, including its path'),
		auth: z
			.discriminatedUnion('method', [z.strictObject({ method: z.literal('none') }), basicAuth])
			.default({ method: 'none' }),
		default_index: defaultIndex,
	}),
	uiHints: { url: { group: 'Repository', order: 1 } },
	connection: (config) => ({
		url: config.url,
		credentials: config.auth.method === 'basic' ? config.auth : undefined,
	}),
});

export const artifactory = definePythonIndex({
	kind: 'jfrog_artifactory',
	title: 'JFrog Artifactory',
	description:
		'Install Python packages from Artifactory with a JWT token or username and password.',
	brand: { color: '#41BF47' },
	configSchema: z.strictObject({
		url: indexUrlField().describe(
			'Artifactory base URL, for example https://company.jfrog.io/artifactory',
		),
		repository: pathSegment().describe('PyPI repository key'),
		auth: z.discriminatedUnion('method', [tokenAuth, basicAuth]),
		default_index: defaultIndex,
	}),
	uiHints: {
		url: { group: 'Repository', order: 1 },
		repository: { group: 'Repository', order: 2 },
	},
	connection: (config) => ({
		url: serviceUrl(config.url, `api/pypi/${encodeURIComponent(config.repository)}/simple/`),
		credentials:
			config.auth.method === 'token' ? { username: '', password: config.auth.token } : config.auth,
	}),
});

export const azureArtifacts = definePythonIndex({
	kind: 'azure_artifacts',
	title: 'Azure Artifacts',
	description: 'Install Python packages from an Azure DevOps feed with a personal access token.',
	brand: { color: '#0078D4' },
	configSchema: z.strictObject({
		organization: pathSegment(),
		project: pathSegment().optional().describe('Omit for an organization-scoped feed'),
		feed: pathSegment(),
		auth: tokenAuth.describe('Azure DevOps personal access token with Packaging read permission'),
		default_index: defaultIndex,
	}),
	uiHints: {
		organization: { group: 'Repository', order: 1 },
		project: { group: 'Repository', order: 2 },
		feed: { group: 'Repository', order: 3 },
	},
	connection(config) {
		const organization = encodeURIComponent(config.organization);
		const project = config.project ? `${encodeURIComponent(config.project)}/` : '';
		return {
			url: `https://pkgs.dev.azure.com/${organization}/${project}_packaging/${encodeURIComponent(config.feed)}/pypi/simple/`,
			credentials: { username: 'dummy', password: config.auth.token },
		};
	},
});

export const gitlabPackages = definePythonIndex({
	kind: 'gitlab_packages',
	title: 'GitLab Package Registry',
	description:
		'Install Python packages from a GitLab project or group with a deploy or personal access token.',
	brand: { color: '#FC6D26' },
	configSchema: z.strictObject({
		url: indexUrlField().default('https://gitlab.com').describe('GitLab instance base URL'),
		scope: z.enum(['project', 'group']).default('project'),
		scope_id: z
			.string()
			.regex(/^[1-9]\d*$/)
			.describe('Numeric GitLab project or group ID'),
		auth: z.strictObject({
			method: z.literal('token'),
			username: usernameField()
				.min(1)
				.describe('Deploy token username or personal access token name'),
			token: zSecret().describe(
				'Deploy token with read_package_registry, or personal access token with api scope',
			),
		}),
		default_index: defaultIndex,
	}),
	uiHints: {
		url: { group: 'Repository', order: 1 },
		scope: { group: 'Repository', order: 2 },
		scope_id: { group: 'Repository', order: 3 },
	},
	connection(config) {
		const path =
			config.scope === 'group' ? `groups/${config.scope_id}/-` : `projects/${config.scope_id}`;
		return {
			url: serviceUrl(config.url, `api/v4/${path}/packages/pypi/simple/`),
			credentials: { username: config.auth.username, password: config.auth.token },
		};
	},
});
