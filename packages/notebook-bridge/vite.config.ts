import { libraryConfig } from '@marimo-hub/vite-config';

export default libraryConfig({
	pack: {
		entry: [
			'src/host.ts',
			'src/notebook.ts',
			'src/protocol.ts',
			'src/query.ts',
			'src/path.ts',
			'src/navigation.ts',
			'src/runtime.ts',
		],
	},
});
