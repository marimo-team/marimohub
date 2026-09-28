import { sandbox } from './valid-compute.mjs';

export default {
	apiVersion: 1,
	kind: 'compute',
	create() {
		const createdOptions = [];
		return {
			createdOptions,
			capabilities: { multiPort: false, gpuProfiles: true },
			warmPool: { maxLifetimeMs: null },
			create(_id, options) {
				createdOptions.push(options);
				return sandbox();
			},
			connectExisting: () => sandbox(),
			proxy: async () => null,
		};
	},
};
