import { sandbox } from './valid-compute.mjs';

export default {
	apiVersion: 1,
	kind: 'compute',
	create({ errors }) {
		return {
			create() {
				return {
					...sandbox(),
					async exec() {
						throw errors.notFound('Sandbox disappeared');
					},
				};
			},
			connectExisting() {
				throw errors.notFound('Sandbox disappeared');
			},
			async proxy() {
				return null;
			},
		};
	},
};
