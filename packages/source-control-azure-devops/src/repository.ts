import {
	AZURE_DEVOPS_ORGANIZATION_PATTERN,
	AZURE_DEVOPS_ORIGIN,
	azureDevOpsRepository,
} from '@marimo-hub/core/git-repo';
import { ValidationError } from '@marimo-hub/core/errors';

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

// Hosted layout only: Server can later supply a collection-based resolver.
export function parseAzureRepository(value: string, organization?: string): AzureRepository {
	const parsed = azureDevOpsRepository(value);
	if (!parsed) {
		throw new ValidationError(
			'Use https://dev.azure.com/{organization}/{project}/_git/{repository}',
		);
	}
	if (organization && parsed.organization !== validateOrganization(organization)) {
		throw new ValidationError('Repository is outside the configured Azure DevOps organization');
	}
	const base = `${AZURE_DEVOPS_ORIGIN}/${parsed.organization}/${encodeURIComponent(parsed.project)}`;
	return {
		organization: parsed.organization,
		project: parsed.project,
		name: parsed.name,
		url: parsed.url,
		apiUrl: `${base}/_apis/git/repositories/${encodeURIComponent(parsed.name)}`,
	};
}
