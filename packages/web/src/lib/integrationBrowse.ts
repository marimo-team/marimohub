import type { IntegrationBrowseCapability, IntegrationKind } from '@/types';

export function supportsTableBrowse(kind: IntegrationKind | undefined): boolean {
	return kind?.browse_surfaces.includes('tables') ?? false;
}

export function supportsObjectBrowse(kind: IntegrationKind | undefined): boolean {
	return kind?.browse_surfaces.includes('objects') ?? false;
}

export function tableBrowseCapability(
	capability: IntegrationBrowseCapability | undefined,
): IntegrationBrowseCapability['surfaces']['tables'] | undefined {
	return capability?.surfaces.tables;
}

export function objectBrowseCapability(
	capability: IntegrationBrowseCapability | undefined,
): IntegrationBrowseCapability['surfaces']['objects'] | undefined {
	return capability?.surfaces.objects;
}
