import { bootstrap } from './bootstrap';
import { localDevEnv, seedLocalDev } from './devSetup';
import { installProcessErrorHandlers } from './processErrors';

installProcessErrorHandlers();
await bootstrap(localDevEnv(process.env), { prepareDeps: seedLocalDev });
