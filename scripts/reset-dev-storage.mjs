import { rm } from 'node:fs/promises';
import path from 'node:path';

const storageRoot = path.resolve(import.meta.dirname, '../.context/dev-storage');

await rm(storageRoot, { recursive: true, force: true });
console.log(`Removed local development state from ${storageRoot}`);
