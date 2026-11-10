import { makeStorage } from '@marimo-hub/config';
import { SessionService } from '@marimo-hub/core';

await new SessionService(makeStorage(process.env)).rebuildSessionIndex();
console.log('Session index rebuilt.');
