import { randomUUID } from 'node:crypto';

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
				const key = `_system/.external-adapter-cas-probe-${randomUUID()}`;
				const seed = await this.put(key, 'seed', { onlyIfNotExists: true });
				try {
					const results = await Promise.allSettled(
						Array.from({ length: 8 }, (_, index) =>
							this.put(key, `contender-${index}`, { onlyIfEtagMatches: seed.etag }),
						),
					);
					for (const result of results) {
						if (result.status === 'rejected' && result.reason?.name !== 'PreconditionFailedError') {
							throw result.reason;
						}
					}
					const winners = results.filter((result) => result.status === 'fulfilled').length;
					if (winners !== 1) {
						throw new Error(
							`External storage does NOT enforce conditional writes atomically: ${winners} concurrent writes succeeded; expected exactly 1`,
						);
					}
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
