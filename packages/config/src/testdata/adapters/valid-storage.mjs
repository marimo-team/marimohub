export default {
	apiVersion: 1,
	kind: 'storage',
	create(context) {
		const objects = new Map();
		const metadata = (object) => ({
			key: object.key,
			etag: object.etag,
			size: object.body.byteLength,
			uploaded: object.uploaded,
		});
		return {
			casScope: 'global',
			factoryContext: context,
			async verifyConditionalWrites() {},
			async get(key) {
				const object = objects.get(key);
				if (!object) return null;
				return {
					...metadata(object),
					async text() {
						return new TextDecoder().decode(object.body);
					},
					async json() {
						return JSON.parse(new TextDecoder().decode(object.body));
					},
					async bytes() {
						return new Uint8Array(object.body);
					},
				};
			},
			async head(key) {
				const object = objects.get(key);
				return object ? metadata(object) : null;
			},
			async put(key, value, options) {
				const current = objects.get(key);
				if (
					(options?.onlyIfNotExists && current) ||
					(options?.onlyIfEtagMatches && current?.etag !== options.onlyIfEtagMatches)
				) {
					throw context.errors.preconditionFailed('fixture precondition failed');
				}
				const body =
					typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
				const object = {
					key,
					etag: `fixture-${objects.size + 1}`,
					body,
					uploaded: new Date(0),
				};
				objects.set(key, object);
				return metadata(object);
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
