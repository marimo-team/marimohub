import { makeStorage, storageBackend } from '@marimo-hub/config';
import { runCatalogRecovery } from './catalogRecovery';

try {
	const result = await runCatalogRecovery(process.argv.slice(2), () => {
		const backend = storageBackend(process.env);
		if (!['s3', 'gcs', 'azure', 'fs'].includes(backend)) {
			throw new Error(
				'This command supports s3, gcs, azure, and fs storage. Other adapters can use CatalogService recovery directly.',
			);
		}
		return makeStorage(process.env);
	});
	console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Catalog recovery failed');
	process.exitCode = 1;
}
