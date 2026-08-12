import type { IntegrationBrowseCapability, IntegrationKind } from '@/types';

export function supportsTableBrowse(kind: IntegrationKind | undefined): boolean {
	return kind?.browse_surfaces.includes('tables') ?? false;
}

export function tableBrowseCapability(
	capability: IntegrationBrowseCapability | undefined,
): IntegrationBrowseCapability['surfaces']['tables'] | undefined {
	return capability?.surfaces.tables;
}
