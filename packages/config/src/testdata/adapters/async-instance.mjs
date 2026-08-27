import { sandbox } from './valid-compute.mjs';

export default {
	apiVersion: 1,
	kind: 'compute',
	create() {
		return {
			async create() {
				return sandbox();
			},
			async proxy() {
				return null;
			},
		};
	},
};
