module.exports = {
	default: {
		apiVersion: 1,
		kind: 'storage',
		create() {
			return {
				casScope: 'global',
				verifyConditionalWrites() {},
				get() {},
				head() {},
				put() {},
				delete() {},
				list() {},
			};
		},
	},
};
