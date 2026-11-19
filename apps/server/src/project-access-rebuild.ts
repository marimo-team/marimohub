import { makeHubStorage } from '@marimo-hub/config/metadata';
import { nodeMetadataFactory } from '@marimo-hub/config/metadata.node';
import { loadAdapterLibraries, makeStorage } from '@marimo-hub/config';
import { CatalogService, ProjectService } from '@marimo-hub/core';

const libraries = await loadAdapterLibraries(process.env);
const storage = makeHubStorage(
	makeStorage(process.env, libraries),
	process.env,
	nodeMetadataFactory,
);
await storage.ready();
const bucket = storage.logicalBucket;
try {
	const projects = new ProjectService(bucket, new CatalogService(bucket));
	await projects.rebuildAccessSummaries();
	console.log('Project access summaries rebuilt; pending mutations remain untrusted.');
} finally {
	await storage.close();
}
