export default {
	apiVersion: 1,
	kind: 'storage',
	async create() {
		await Promise.resolve();
		return {
			casScope: 'global',
			async verifyConditionalWrites() {},
			async get() {
				return null;
			},
			async head() {
				return null;
			},
			async put(key, value) {
				return { key, etag: 'async', size: value.length, uploaded: new Date(0) };
			},
			async delete() {},
			async list() {
				return { objects: [], truncated: false, delimitedPrefixes: [] };
			},
		};
	},
};
