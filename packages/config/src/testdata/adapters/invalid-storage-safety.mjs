export default {
	apiVersion: 1,
	kind: 'storage',
	create(context) {
		const adapter = {
			casScope: 'global',
			async verifyConditionalWrites() {},
			async get() {
				return null;
			},
			async head() {
				return null;
			},
			async put(key, value) {
				return { key, etag: 'invalid', size: value.length, uploaded: new Date(0) };
			},
			async delete() {},
			async list() {
				return { objects: [], truncated: false, delimitedPrefixes: [] };
			},
		};
		switch (context.env.MARIMOHUB_STORAGE_LIBRARY_INVALID_SAFETY) {
			case 'missing-probe':
				delete adapter.verifyConditionalWrites;
				break;
			case 'invalid-probe':
				adapter.verifyConditionalWrites = 'invalid';
				break;
			case 'missing-scope':
				delete adapter.casScope;
				break;
			case 'invalid-scope':
				adapter.casScope = 'instance';
				break;
		}
		return adapter;
	},
};
