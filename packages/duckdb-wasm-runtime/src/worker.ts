import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerGlobal = globalThis as typeof globalThis & {
	__dirname?: string;
	__filename?: string;
};
workerGlobal.__filename = fileURLToPath(import.meta.url);
workerGlobal.__dirname = dirname(workerGlobal.__filename);

await import('./workerHandler.ts');
