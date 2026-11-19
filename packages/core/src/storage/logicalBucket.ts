import { assertValidBucketListLimit, compareBucketKeys } from '../ports/bucket';
import type { Bucket, BucketListOptions, BucketListResult, BucketObject } from '../ports/bucket';
import type { HubStorage, MetadataStore } from '../ports/metadata';
import { classifyMetadataKey, METADATA_MANIFEST_VERSION } from './metadataKeys';

export function createLogicalStorage(
	rawArtifacts: Bucket,
	metadata: MetadataStore,
	identity: { namespace: string; epoch: number },
): HubStorage {
	if (!identity.namespace || !Number.isSafeInteger(identity.epoch) || identity.epoch < 1) {
		throw new Error('Invalid storage identity');
	}
	function artifactKey(key: string): void {
		if (classifyMetadataKey(key) !== 'artifact')
			throw new Error('Artifact operation requires an artifact key');
	}
	function store(key: string): MetadataStore {
		const placement = classifyMetadataKey(key);
		if (placement === 'control')
			throw new Error('Backend control records require administrative access');
		return placement === 'metadata' ? metadata : rawArtifacts;
	}

	type Entry = { key: string; object: BucketObject } | { key: string; prefix: string };
	async function* entries(
		source: MetadataStore,
		placement: 'artifact' | 'metadata',
		options: BucketListOptions,
	): AsyncGenerator<Entry> {
		let cursor: string | undefined;
		do {
			const page = await source.list({
				prefix: options.prefix,
				delimiter: options.delimiter || undefined,
				startAfter: options.startAfter,
				cursor,
				limit: Math.min(options.limit ?? 1000, 1000),
			});
			const entries: Entry[] = [
				...page.objects
					.filter((object) => classifyMetadataKey(object.key) === placement)
					.map((object) => ({ key: object.key, object })),
				...page.delimitedPrefixes.map((prefix) => ({ key: prefix, prefix })),
			];
			entries.sort((left, right) => compareBucketKeys(left.key, right.key));
			for (const entry of entries) yield entry;
			cursor = page.cursor;
		} while (cursor);
	}

	async function list(
		options: BucketListOptions = {},
		artifactsOnly = false,
	): Promise<BucketListResult> {
		assertValidBucketListLimit(options.limit);
		const prefix = options.prefix ?? '';
		const delimiter = options.delimiter ?? '';
		const binding = JSON.stringify([
			METADATA_MANIFEST_VERSION,
			identity.namespace,
			identity.epoch,
			prefix,
			delimiter,
			artifactsOnly,
		]);
		let after = options.startAfter;
		let previousPrefix: string | undefined;
		if (options.cursor) {
			try {
				const token: unknown = JSON.parse(decodeURIComponent(atob(options.cursor)));
				if (
					!Array.isArray(token) ||
					token.length !== 3 ||
					token[0] !== binding ||
					typeof token[1] !== 'string' ||
					(token[2] !== null && typeof token[2] !== 'string')
				)
					throw new Error('Invalid cursor shape');
				after = token[1];
				previousPrefix = token[2] ?? undefined;
			} catch {
				throw new Error('Invalid logical storage cursor');
			}
		}
		const inputs = [
			entries(rawArtifacts, 'artifact', {
				prefix,
				delimiter,
				startAfter: after,
				limit: options.limit,
			}),
		];
		if (!artifactsOnly)
			inputs.push(
				entries(metadata, 'metadata', {
					prefix,
					delimiter,
					startAfter: after,
					limit: options.limit,
				}),
			);
		const heads = await Promise.all(inputs.map((input) => input.next()));
		const objects: BucketObject[] = [];
		const delimitedPrefixes: string[] = [];
		const limit = options.limit ?? 1000;
		let lastKey = after ?? '';
		let lastPrefix = previousPrefix;
		while (true) {
			let selected = -1;
			for (let i = 0; i < heads.length; i++) {
				if (
					!heads[i].done &&
					(selected === -1 ||
						compareBucketKeys(heads[i].value!.key, heads[selected].value!.key) < 0)
				)
					selected = i;
			}
			if (selected === -1) return { objects, delimitedPrefixes, truncated: false };
			const entry = heads[selected].value!;
			const rolled = 'prefix' in entry ? entry.prefix : undefined;
			if (rolled === undefined || rolled !== lastPrefix) {
				if (objects.length + delimitedPrefixes.length === limit) {
					return {
						objects,
						delimitedPrefixes,
						truncated: true,
						cursor: btoa(
							encodeURIComponent(JSON.stringify([binding, lastKey, lastPrefix ?? null])),
						),
					};
				}
				if (rolled) delimitedPrefixes.push(rolled);
				else if ('object' in entry) objects.push(entry.object);
				lastPrefix = rolled;
			}
			lastKey = entry.key;
			heads[selected] = await inputs[selected].next();
		}
	}

	const logicalBucket: Bucket = {
		get: ((key, options) => store(key).get(key, options)) as Bucket['get'],
		head: (key) => store(key).head(key),
		put: (key, value, options) => store(key).put(key, value, options),
		async delete(keys) {
			const groups = new Map<MetadataStore, string[]>();
			for (const key of typeof keys === 'string' ? [keys] : keys) {
				const target = store(key);
				const group = groups.get(target);
				if (group) group.push(key);
				else groups.set(target, [key]);
			}
			for (const [target, selected] of groups) await target.delete(selected);
		},
		list,
	};
	if (rawArtifacts.putStream) {
		logicalBucket.putStream = (key, chunks, size, options) => {
			artifactKey(key);
			return rawArtifacts.putStream!(key, chunks, size, options);
		};
	}
	const multipart = rawArtifacts.multipart;
	if (multipart) {
		logicalBucket.multipart = {
			isolatedSessions: multipart.isolatedSessions,
			create: (key, options) => {
				artifactKey(key);
				return multipart.create(key, options);
			},
			putPart: (key, uploadId, partNumber, bytes) => {
				artifactKey(key);
				return multipart.putPart(key, uploadId, partNumber, bytes);
			},
			complete: (key, uploadId, parts) => {
				artifactKey(key);
				return multipart.complete(key, uploadId, parts);
			},
			abort: (key, uploadId) => {
				artifactKey(key);
				return multipart.abort(key, uploadId);
			},
		};
	}
	const artifacts: Bucket = {
		...logicalBucket,
		get: ((key, options) => {
			artifactKey(key);
			return rawArtifacts.get(key, options);
		}) as Bucket['get'],
		head: (key) => {
			artifactKey(key);
			return rawArtifacts.head(key);
		},
		put: (key, value, options) => {
			artifactKey(key);
			return rawArtifacts.put(key, value, options);
		},
		delete: (keys) => {
			for (const key of typeof keys === 'string' ? [keys] : keys) artifactKey(key);
			return rawArtifacts.delete(keys);
		},
		list: (options) => list(options, true),
	};
	return { artifacts, metadata, logicalBucket };
}
