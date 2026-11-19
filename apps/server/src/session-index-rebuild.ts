import { makeHubStorage } from '@marimo-hub/config/metadata';
import { nodeMetadataFactory } from '@marimo-hub/config/metadata.node';
import { loadAdapterLibraries, makeStorage } from '@marimo-hub/config';
import { SessionService } from '@marimo-hub/core';

const libraries = await loadAdapterLibraries(process.env);
const storage = makeHubStorage(
	makeStorage(process.env, libraries),
	process.env,
	nodeMetadataFactory,
);
await storage.ready();
try {
	await new SessionService(storage.logicalBucket).rebuildSessionIndex();
	console.log('Session index rebuilt.');
} finally {
	await storage.close();
}
