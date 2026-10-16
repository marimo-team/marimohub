import { AZURE_DEVOPS_ORGANIZATION_PATTERN } from '@marimo-hub/core/git-repo';
import { ValidationError } from '@marimo-hub/core/errors';
import { hasControlCharacter } from './validation';

export interface AzureRepository {
	organization: string;
	project: string;
	name: string;
	url: string;
	apiUrl: string;
}

export function validateOrganization(value: string): string {
	if (!AZURE_DEVOPS_ORGANIZATION_PATTERN.test(value)) {
		throw new ValidationError('Invalid Azure DevOps organization');
	}
	return value.toLowerCase();
}

// Keep the hosted URL layout here: Server can later supply a collection-based resolver.
export function parseAzureRepository(value: string, organization?: string): AzureRepository {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ValidationError('Use an Azure DevOps HTTPS repository URL');
	}
	if (
		url.origin !== 'https://dev.azure.com' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new ValidationError(
			'Use https://dev.azure.com/{organization}/{project}/_git/{repository}',
		);
	}
	const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
	if (parts.length !== 4 || parts[2] !== '_git')
		throw new ValidationError('Invalid Azure DevOps repository URL');
	let decoded: string[];
	try {
		decoded = parts.map(decodeURIComponent);
	} catch {
		throw new ValidationError('Invalid Azure DevOps repository URL');
	}
	const [org, project, , name] = decoded;
	if (
		!org ||
		!project ||
		!name ||
		decoded.some(
			(part) =>
				!part || part === '.' || part === '..' || hasControlCharacter(part) || /[/\\]/.test(part),
		)
	) {
		throw new ValidationError('Invalid Azure DevOps repository URL');
	}
	const canonicalOrg = validateOrganization(org);
	if (organization && canonicalOrg !== validateOrganization(organization)) {
		throw new ValidationError('Repository is outside the configured Azure DevOps organization');
	}
	const base = `https://dev.azure.com/${canonicalOrg}/${encodeURIComponent(project)}`;
	return {
		organization: canonicalOrg,
		project,
		name,
		url: `${base}/_git/${encodeURIComponent(name)}`,
		apiUrl: `${base}/_apis/git/repositories/${encodeURIComponent(name)}`,
	};
}
