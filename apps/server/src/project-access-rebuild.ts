import { loadAdapterLibraries, makeStorage } from '@marimo-hub/config';
import { CatalogService, ProjectService } from '@marimo-hub/core';

const generation = process.env.MARIMOHUB_PROJECT_ACCESS_GENERATION?.trim();
if (!generation) throw new Error('MARIMOHUB_PROJECT_ACCESS_GENERATION is required');
const libraries = await loadAdapterLibraries(process.env);
const bucket = makeStorage(process.env, libraries);
const projects = new ProjectService(
	bucket,
	new CatalogService(bucket),
	undefined,
	undefined,
	undefined,
	generation,
);
await projects.rebuildAccessSummaries();
console.log('Project access summaries rebuilt; pending mutations remain untrusted.');
