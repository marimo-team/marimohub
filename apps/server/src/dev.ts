import { bootstrap } from './bootstrap';
import { resolveDevHostname } from './devHost';
import { localDevEnv, seedLocalDev } from './devSetup';
import { installProcessErrorHandlers } from './processErrors';

installProcessErrorHandlers();
await bootstrap(localDevEnv(process.env), {
	prepareDeps: seedLocalDev,
	hostname: resolveDevHostname(process.env),
});
