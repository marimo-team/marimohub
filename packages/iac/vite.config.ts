import { libraryConfig } from '@marimo-hub/vite-config';

export default libraryConfig({ pack: { entry: ['src/index.ts', 'src/runner.ts'] } });
