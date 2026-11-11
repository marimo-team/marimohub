import { loadAdapterLibraries, makeStorage } from '@marimo-hub/config';
import { CatalogService, ProjectService } from '@marimo-hub/core';

const libraries = await loadAdapterLibraries(process.env);
const bucket = makeStorage(process.env, libraries);
const projects = new ProjectService(bucket, new CatalogService(bucket));
await projects.rebuildAccessSummaries();
console.log('Project access summaries rebuilt; pending mutations remain untrusted.');
