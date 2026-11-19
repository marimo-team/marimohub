import { makeHubStorage } from '@marimo-hub/config/metadata';
import type { ResolvedHubStorage } from '@marimo-hub/config/metadata';
import { nodeMetadataFactory } from '@marimo-hub/config/metadata.node';
// Bundled CLI entrypoint (dist/catalog-recovery.mjs); the logic lives in catalogRecovery.ts.
import { makeStorage, storageBackend } from '@marimo-hub/config';
import { catalogRecoveryMain } from './catalogRecovery';

let storage: ResolvedHubStorage | undefined;
try {
	process.exitCode = await catalogRecoveryMain(
		process.argv.slice(2),
		async () => {
			const backend = storageBackend(process.env);
			if (!['s3', 'gcs', 'azure', 'fs'].includes(backend)) {
				throw new Error(
					'This command supports s3, gcs, azure, and fs storage. Other adapters can use CatalogService recovery directly.',
				);
			}
			storage = makeHubStorage(makeStorage(process.env), process.env, nodeMetadataFactory);
			await storage.ready();
			return storage.logicalBucket;
		},
		{ log: console.log, error: console.error },
	);
} finally {
	await storage?.close();
}
