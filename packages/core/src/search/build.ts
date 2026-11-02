import type { SearchBuild } from './contracts';

export function sameSearchBuild(a: SearchBuild | undefined, b: SearchBuild): boolean {
	return (
		a?.revision === b.revision &&
		a.source_revision === b.source_revision &&
		a.configuration === b.configuration
	);
}

export function canClaimSearchBuild(current: SearchBuild | undefined, next: SearchBuild): boolean {
	if (!current) return true;
	if (next.revision < current.revision || next.source_revision < current.source_revision)
		return false;
	if (sameSearchBuild(current, next)) return true;
	if (next.revision === current.revision && next.source_revision === current.source_revision)
		throw new Error('Search build configuration changed; increase MARIMOHUB_SEARCH_BUILD_REVISION');
	return true;
}
