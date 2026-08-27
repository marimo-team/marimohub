export default {
	apiVersion: 1,
	kind: 'compute',
	create() {
		return {
			async create() {
				return {};
			},
			async proxy() {
				return null;
			},
		};
	},
};
