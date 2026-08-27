import { sandbox } from './valid-compute.mjs';

export default {
	apiVersion: 1,
	kind: 'compute',
	create() {
		return {
			create() {
				const instance = sandbox();
				delete instance.execStream;
				delete instance.readFile;
				return instance;
			},
			async proxy() {
				return null;
			},
		};
	},
};
