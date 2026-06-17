import type { Bucket } from '../ports/bucket';
import { type Metrics, noopMetrics } from '../ports/metrics';
import { paths } from '../paths';
import { CatalogService } from './CatalogService';
import { EventService } from './EventService';
import { MaintenanceService } from './MaintenanceService';
import { NotebookService } from './NotebookService';
import { ProjectService } from './ProjectService';
import { SessionService } from './SessionService';

export { CatalogService } from './CatalogService';
export { EventService } from './EventService';
export { MaintenanceService } from './MaintenanceService';
export type { ExpireSnapshotsOptions, PruneEventsOptions } from './MaintenanceService';
export { MaintenanceLock } from './MaintenanceLock';
export { MAX_VERSIONS, NotebookService } from './NotebookService';
export { ProjectService } from './ProjectService';
export { ReconciliationService } from './ReconciliationService';
export type { ReconcileResult } from './ReconciliationService';
export { listAllKeys } from './storage';
export { SandboxProvisioner } from './SandboxProvisioner';
export type { BucketConfig, ProvisionOptions, ProvisionResult } from './SandboxProvisioner';
export { loadNotebookFiles, saveNotebookFiles } from './sandboxFiles';
export { SessionService } from './SessionService';

/**
 * Compose the domain services over a bucket. `metrics` is optional and defaults
 * to a no-op, so tests and library-mode callers are unaffected; entrypoints pass
 * a real emitter (e.g. the wide-event logger) to light up observability.
 */
export function createServices(bucket: Bucket, metrics: Metrics = noopMetrics) {
	const catalog = new CatalogService(bucket, metrics);
	const events = new EventService(bucket);
	const projects = new ProjectService(bucket, catalog);
	const notebooks = new NotebookService(bucket, catalog);
	const sessions = new SessionService(bucket, metrics);
	const maintenance = new MaintenanceService(bucket, metrics);
	return { catalog, events, projects, notebooks, sessions, maintenance };
}

/**
 * Ensures the catalog and a default project exist.
 * Uses a cheap head() check — only does full init on first call.
 */
export async function ensureInitialized(bucket: Bucket, actor: string): Promise<void> {
	const exists = await bucket.head(paths.catalog);
	if (exists) return;

	const services = createServices(bucket);
	// initialize() is now atomic (create-if-absent on catalog.json), so concurrent
	// callers converge on a single catalog rather than clobbering one another.
	await services.catalog.initialize(actor);

	// Re-read snapshot in case a concurrent request already created the default
	// project. The default-project guard relies on createProject's CAS: a
	// concurrent default create is bounded by that CAS plus the length === 0
	// check, so a rare duplicate default project is acceptable (idempotency of
	// project creation is tracked separately). Do not add a lock here.
	const snapshot = await services.catalog.getCurrentSnapshot();
	if (snapshot.projects.length === 0) {
		await services.projects.createProject(
			{ name: 'My Projects', description: 'Default project' },
			actor,
		);
	}
}
