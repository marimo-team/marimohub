// Bundled CLI entrypoint (dist/catalog-recovery.mjs); the logic lives in catalogRecovery.ts.
import { makeStorage, storageBackend } from '@marimo-hub/config';
import { catalogRecoveryMain } from './catalogRecovery';

process.exitCode = await catalogRecoveryMain(
	process.argv.slice(2),
	() => {
		const backend = storageBackend(process.env);
		if (!['s3', 'gcs', 'azure', 'fs'].includes(backend)) {
			throw new Error(
				'This command supports s3, gcs, azure, and fs storage. Other adapters can use CatalogService recovery directly.',
			);
		}
		return makeStorage(process.env);
	},
	{ log: console.log, error: console.error },
);
