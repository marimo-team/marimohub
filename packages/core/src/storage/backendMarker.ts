import { z } from 'zod';
import type { Bucket } from '../ports/bucket';
import { METADATA_BACKEND_KEY } from './metadataKeys';

export const MetadataBackendMarkerSchema = z
	.object({
		version: z.literal(1),
		artifact_store_id: z.uuid(),
		backend: z.enum(['bucket', 'postgres']),
		epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		state: z.enum(['active', 'frozen']),
		namespace: z.string().min(1).nullable(),
		transfer_id: z.uuid().nullable(),
	})
	.refine((marker) =>
		marker.backend === 'bucket' ? marker.namespace === null : marker.namespace !== null,
	);
export type MetadataBackendMarker = z.infer<typeof MetadataBackendMarkerSchema>;

export async function readMetadataBackendMarker(
	bucket: Bucket,
): Promise<MetadataBackendMarker | null> {
	const record = await bucket.get(METADATA_BACKEND_KEY);
	return record ? MetadataBackendMarkerSchema.parse(await record.json()) : null;
}

export async function assertBucketMetadataBackend(bucket: Bucket): Promise<void> {
	const marker = await readMetadataBackendMarker(bucket);
	if (marker && (marker.backend !== 'bucket' || marker.state !== 'active'))
		throw new Error('Artifact bucket metadata backend is incompatible or frozen');
}
