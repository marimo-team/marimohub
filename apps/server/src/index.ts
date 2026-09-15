/**
 * marimohub Node entrypoint (Docker / Kubernetes control plane).
 *
 * Composes the provider-agnostic API with adapters selected from MARIMOHUB_*
 * env (S3 storage + Modal compute + app-native OIDC by default), serves the
 * prebuilt SPA, and runs session maintenance. The API tier is stateless — all
 * state lives in object storage + compute — so this scales horizontally.
 */
import { bootstrap } from './bootstrap';
import { installProcessErrorHandlers } from './processErrors';

installProcessErrorHandlers();

// Keep server-owned env reads at the process boundary, where the config registry
// inventories them; adapter env remains opaque to this entrypoint.
await bootstrap({
	...process.env,
	PORT: process.env.PORT,
	MARIMOHUB_STATIC_ROOT: process.env.MARIMOHUB_STATIC_ROOT,
	MARIMOHUB_RUN_MAINTENANCE: process.env.MARIMOHUB_RUN_MAINTENANCE,
});
