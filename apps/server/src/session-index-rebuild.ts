import { loadAdapterLibraries, makeStorage } from '@marimo-hub/config';
import { SessionService } from '@marimo-hub/core';

const libraries = await loadAdapterLibraries(process.env);
await new SessionService(makeStorage(process.env, libraries)).rebuildSessionIndex();
console.log('Session index rebuilt.');
