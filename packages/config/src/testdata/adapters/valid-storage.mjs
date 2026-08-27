export default {
	apiVersion: 1,
	kind: 'storage',
	create(context) {
		const objects = new Map();
		return {
			casScope: 'global',
			factoryContext: context,
			async verifyConditionalWrites() {},
			async get(key) {
				return objects.get(key) ?? null;
			},
			async head(key) {
				return objects.get(key) ?? null;
			},
			async put(key, value, options) {
				const current = objects.get(key);
				if (
					(options?.onlyIfNotExists && current) ||
					(options?.onlyIfEtagMatches && current?.etag !== options.onlyIfEtagMatches)
				) {
					throw context.errors.preconditionFailed('fixture precondition failed');
				}
				const object = {
					key,
					etag: `fixture-${objects.size + 1}`,
					size: value.length,
					uploaded: new Date(0),
				};
				objects.set(key, object);
				return object;
			},
			async delete(keys) {
				for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
			},
			async list() {
				return { objects: [], truncated: false, delimitedPrefixes: [] };
			},
		};
	},
};
