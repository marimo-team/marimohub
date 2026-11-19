import { loadAdapterLibraries, makeStorage } from '@marimo-hub/config';
import { inspectMetadataDeployment } from '@marimo-hub/config/metadata.node';
import { readMetadataBackendMarker } from '@marimo-hub/core/storage/backend-marker';
import { classifyMetadataKey } from '@marimo-hub/core/storage/metadata-keys';

const libraries = await loadAdapterLibraries(process.env);
const bucket = makeStorage(process.env, libraries);
const marker = await readMetadataBackendMarker(bucket);
const counts = { metadata: 0, artifact: 0, control: 0, unknown: 0 };
let cursor: string | undefined;
do {
	const page = await bucket.list({ limit: 1000, cursor });
	for (const object of page.objects) {
		try {
			counts[classifyMetadataKey(object.key)]++;
		} catch {
			counts.unknown++;
		}
	}
	cursor = page.cursor;
} while (cursor);
const namespace = process.env.MARIMOHUB_METADATA_NAMESPACE;
const url = process.env.MARIMOHUB_METADATA_ADMIN_POSTGRES_URL;
const sql = url && namespace ? await inspectMetadataDeployment(url, namespace) : undefined;
console.log(JSON.stringify({ marker, counts, sql }, null, 2));
