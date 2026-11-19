import type { BucketObjectBody } from '../ports/bucket';
import { sha256Hex } from '../internal/sha256';

export interface ArtifactDigest {
	size_bytes: number;
	sha256: string;
}

export async function matchesArtifactDigest(
	artifact: BucketObjectBody | null,
	expected: ArtifactDigest,
): Promise<boolean> {
	return (
		artifact !== null &&
		artifact.size === expected.size_bytes &&
		(await sha256Hex(await artifact.bytes())) === expected.sha256
	);
}
