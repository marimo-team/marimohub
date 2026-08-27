export default {
	apiVersion: 1,
	kind: 'compute',
	create() {
		return {
			create() {
				return { exec() {}, destroy() {} };
			},
			async proxy() {
				return null;
			},
		};
	},
};
