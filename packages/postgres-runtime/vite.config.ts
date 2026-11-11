import { libraryConfig } from '@marimo-hub/vite-config';

export default libraryConfig({
	pack: { entry: ['src/node.ts', 'src/worker.ts'] },
	test: { maxConcurrency: 2 },
});
