const objects = new Map();
let nextEtag = 1;

function metadata(key, object) {
	return {
		key,
		etag: object.etag,
		size: object.body.length,
		uploaded: object.uploaded,
	};
}

export default {
	apiVersion: 1,
	kind: 'storage',
	create(context) {
		return {
			casScope: 'process',
			async get(key) {
				const object = objects.get(key);
				if (!object) return null;
				return {
					...metadata(key, object),
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
				return object ? metadata(key, object) : null;
			},
			async put(key, value, options) {
				const current = objects.get(key);
				if (options?.onlyIfEtagMatches && options?.onlyIfNotExists) {
					throw new Error('onlyIfEtagMatches and onlyIfNotExists are mutually exclusive');
				}
				if (
					(options?.onlyIfNotExists && current) ||
					(options?.onlyIfEtagMatches && current?.etag !== options.onlyIfEtagMatches)
				) {
					throw context.errors.preconditionFailed(`Precondition failed for "${key}"`);
				}
				const body =
					typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
				const object = { body, etag: `example-${nextEtag++}`, uploaded: new Date() };
				objects.set(key, object);
				return metadata(key, object);
			},
			async verifyConditionalWrites() {
				const key = '_system/.external-adapter-cas-probe';
				const seed = await this.put(key, 'seed');
				try {
					let rejected = false;
					try {
						await this.put(key, 'stale', { onlyIfEtagMatches: 'wrong-etag' });
					} catch (error) {
						if (error?.name !== 'PreconditionFailedError') throw error;
						rejected = true;
					}
					if (!rejected) {
						throw new Error('External storage does NOT enforce conditional writes');
					}
					await this.put(key, 'updated', { onlyIfEtagMatches: seed.etag });
				} finally {
					await this.delete(key);
				}
			},
			async delete(keys) {
				for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
			},
			async list(options = {}) {
				const objectsInPrefix = [...objects.entries()]
					.filter(([key]) => key.startsWith(options.prefix ?? ''))
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, object]) => metadata(key, object));
				return { objects: objectsInPrefix, truncated: false, delimitedPrefixes: [] };
			},
		};
	},
};
