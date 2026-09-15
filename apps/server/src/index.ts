/**
 * marimohub Node entrypoint (Docker / Kubernetes control plane).
 *
 * Composes the provider-agnostic API with adapters selected from MARIMOHUB_*
 * env (S3 storage + Modal compute + app-native OIDC by default), serves the
 * prebuilt SPA, and runs session maintenance. The API tier is stateless — all
 * state lives in object storage + compute — so this scales horizontally.
 */
import { installProcessErrorHandlers } from './processErrors';
import { runServiceAccountCommand, SERVICE_ACCOUNT_HELP } from './serviceAccountCommand';

installProcessErrorHandlers();

const args = process.argv.slice(2);
if (args.length > 0) {
	try {
		if (args[0] === 'service-account') await runServiceAccountCommand(args.slice(1));
		else if (args.length === 1 && args[0] === '--help') process.stdout.write(SERVICE_ACCOUNT_HELP);
		else throw new Error('Unknown command; use --help');
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
} else {
	const { bootstrap } = await import('./bootstrap');
	// Keep server-owned env reads at the process boundary for the config registry.
	await bootstrap({
		...process.env,
		PORT: process.env.PORT,
		MARIMOHUB_STATIC_ROOT: process.env.MARIMOHUB_STATIC_ROOT,
		MARIMOHUB_RUN_MAINTENANCE: process.env.MARIMOHUB_RUN_MAINTENANCE,
	});
}
