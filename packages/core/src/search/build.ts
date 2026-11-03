import { sha256Hex } from '../internal/sha256';
import type { SearchBuild, SearchSnapshot } from './contracts';

export function sameSearchBuild(a: SearchBuild | undefined, b: SearchBuild): boolean {
	return (
		a?.revision === b.revision &&
		a.source_revision === b.source_revision &&
		a.configuration === b.configuration
	);
}

/**
 * Revisions never decrease. At equal revisions the newest configuration wins: the maintenance
 * lease admits one indexer at a time, so a configuration change cannot interleave writers.
 */
export function canClaimSearchBuild(current: SearchBuild | undefined, next: SearchBuild): boolean {
	return (
		!current ||
		(next.revision >= current.revision && next.source_revision >= current.source_revision)
	);
}

/** Order-independent digest of everything a snapshot serves except its timestamp. */
export function searchSnapshotDigest(
	snapshot: Pick<SearchSnapshot, 'partial' | 'documents'>,
): Promise<string> {
	const documents = snapshot.documents.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return sha256Hex(JSON.stringify([snapshot.partial, documents]));
}
