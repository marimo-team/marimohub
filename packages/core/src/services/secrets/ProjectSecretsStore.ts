import type { Bucket } from '../../ports/bucket';
import type {
	ManagedSecretCodec,
	SecretEntryMeta,
	SecretEnvelope,
	SecretInput,
	SecretResolver,
	SecretsProvider,
} from '../../ports/secrets';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { ValidationError } from '../../errors';
import type { ProjectId, UserId } from '../../ids';
import { paths } from '../../paths';
import { listAllObjects } from '../catalog/storage';
import { assertValidSecretName } from './secretName';

/** The stored object at `projects/{pid}/secrets/<name>.json`, discriminated by kind. */
type StoredSecret =
	| {
			kind: 'reference';
			backend: string;
			locator: string;
			/** `'json'` fans the resolved JSON object out into one env var per key. */
			expand?: 'json';
			prefix?: string;
			name: string;
			created_by: UserId;
			created_at: string;
			updated_at: string;
	  }
	| {
			kind: 'managed';
			envelope: SecretEnvelope;
			name: string;
			created_by: UserId;
			created_at: string;
			updated_at: string;
	  };

export interface ProjectSecretsStoreOptions {
	bucket: Bucket;
	/** Reference backends, keyed by `backend`. Empty is valid (managed-only). */
	resolvers?: SecretResolver[];
	/** The encrypted-in-bucket codec for `managed` entries; absent disables them. */
	managed?: ManagedSecretCodec;
	/** Injectable clock for deterministic tests. */
	now?: () => string;
}

/**
 * Vendor-free default {@link SecretsProvider}: persists one JSON object per entry
 * in the bucket (last-writer-wins, no CAS — the deliberately-mutable secret class),
 * and dispatches `resolve` to a registered {@link SecretResolver} (reference) or the
 * {@link ManagedSecretCodec} (managed).
 */
export class ProjectSecretsStore implements SecretsProvider {
	private readonly bucket: Bucket;
	private readonly resolvers: Map<string, SecretResolver>;
	private readonly managed?: ManagedSecretCodec;
	private readonly now: () => string;

	constructor(opts: ProjectSecretsStoreOptions) {
		this.bucket = opts.bucket;
		this.resolvers = new Map((opts.resolvers ?? []).map((r) => [r.backend, r]));
		this.managed = opts.managed;
		this.now = opts.now ?? (() => new Date().toISOString());
	}

	async list(projectId: ProjectId): Promise<SecretEntryMeta[]> {
		const objects = await listAllObjects(this.bucket, paths.project(projectId).secretsPrefix);
		const metas = await mapWithConcurrency(objects, BUCKET_SCAN_CONCURRENCY, async (o) => {
			const body = await this.bucket.get(o.key);
			if (!body) return null; // deleted between list and get — skip
			return toMeta(await body.json<StoredSecret>());
		});
		return metas.filter((m) => m !== null);
	}

	async put(
		projectId: ProjectId,
		name: string,
		input: SecretInput,
		actor: UserId,
	): Promise<SecretEntryMeta> {
		assertValidSecretName(name);
		const key = paths.project(projectId).secret(name);
		const existing = await this.readStored(key);
		const created_at = existing?.created_at ?? this.now();
		const created_by = existing?.created_by ?? actor;
		const updated_at = this.now();

		let stored: StoredSecret;
		if (input.kind === 'reference') {
			if (!this.resolvers.has(input.ref.backend)) {
				throw new ValidationError(
					`Unknown secret backend "${input.ref.backend}" — no resolver is configured for it.`,
				);
			}
			stored = {
				kind: 'reference',
				backend: input.ref.backend,
				locator: input.ref.locator,
				...(input.ref.expand ? { expand: input.ref.expand } : {}),
				...(input.ref.prefix ? { prefix: input.ref.prefix } : {}),
				name,
				created_by,
				created_at,
				updated_at,
			};
		} else {
			if (!this.managed) {
				throw new ValidationError('Managed secrets are not configured on this deployment.');
			}
			const envelope = await this.managed.encrypt(input.value, { path: key });
			stored = { kind: 'managed', envelope, name, created_by, created_at, updated_at };
		}

		await this.bucket.put(key, JSON.stringify(stored));
		return toMeta(stored);
	}

	async delete(projectId: ProjectId, name: string): Promise<void> {
		// Tolerate a not-found delete (idempotent); the bucket delete is already a no-op.
		await this.bucket.delete(paths.project(projectId).secret(name));
	}

	async validate(input: SecretInput): Promise<void> {
		if (input.kind !== 'reference') return; // managed: nothing external to probe
		const resolver = this.resolvers.get(input.ref.backend);
		if (!resolver) {
			throw new ValidationError(
				`Unknown secret backend "${input.ref.backend}" — no resolver is configured for it.`,
			);
		}
		const value = await resolver.resolve(input.ref);
		// For a fan-out, also confirm the payload is JSON with valid derived names.
		if (input.ref.expand === 'json') expandJson(value, input.ref.prefix, '(reference)');
	}

	async resolve(projectId: ProjectId): Promise<Record<string, string>> {
		const objects = await listAllObjects(this.bucket, paths.project(projectId).secretsPrefix);
		// Resolve entries in bounded-parallel; any single throw rejects the whole
		// call (fail-closed). Collision detection runs after all maps return.
		const maps = await mapWithConcurrency(
			objects,
			BUCKET_SCAN_CONCURRENCY,
			async (o): Promise<Record<string, string>> => {
				const stored = await this.readStored(o.key);
				return stored ? this.resolveOne(stored, o.key) : {};
			},
		);
		const out: Record<string, string> = {};
		for (const map of maps) {
			for (const [name, value] of Object.entries(map)) {
				if (name in out) {
					throw new ValidationError(`Secret name collision: "${name}" is produced by two entries.`);
				}
				out[name] = value;
			}
		}
		return out;
	}

	private async resolveOne(stored: StoredSecret, key: string): Promise<Record<string, string>> {
		if (stored.kind === 'reference') {
			const resolver = this.resolvers.get(stored.backend);
			if (!resolver) {
				// A deployment that dropped a backend must not silently skip a secret.
				throw new ValidationError(
					`Cannot resolve secret "${stored.name}": no resolver for backend "${stored.backend}".`,
				);
			}
			const value = await resolver.resolve({
				backend: stored.backend,
				locator: stored.locator,
				expand: stored.expand,
				prefix: stored.prefix,
			});
			return stored.expand === 'json'
				? expandJson(value, stored.prefix, stored.name)
				: { [stored.name]: value };
		}
		if (!this.managed) {
			throw new ValidationError(
				`Cannot resolve managed secret "${stored.name}": managed secrets are not configured.`,
			);
		}
		return { [stored.name]: await this.managed.decrypt(stored.envelope, { path: key }) };
	}

	private async readStored(key: string): Promise<StoredSecret | null> {
		const body = await this.bucket.get(key);
		return body ? body.json<StoredSecret>() : null;
	}
}

/**
 * Fan a JSON-object secret out into `{ derivedName: value }`. Each key becomes
 * `${prefix}${key}` and must pass {@link assertValidSecretName}; a non-string value
 * is JSON-stringified. Throws (naming the entry, never the value) on a non-JSON
 * payload or an invalid derived name — fail-closed.
 */
function expandJson(
	value: string,
	prefix: string | undefined,
	entryName: string,
): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ValidationError(
			`Secret "${entryName}" is set to expand JSON, but its value is not a JSON object.`,
		);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new ValidationError(
			`Secret "${entryName}" is set to expand JSON, but its value is not a JSON object.`,
		);
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(parsed)) {
		const derived = `${prefix ?? ''}${k}`;
		assertValidSecretName(derived);
		out[derived] = typeof v === 'string' ? v : JSON.stringify(v);
	}
	return out;
}

function toMeta(s: StoredSecret): SecretEntryMeta {
	const base = {
		name: s.name,
		kind: s.kind,
		created_by: s.created_by,
		created_at: s.created_at,
		updated_at: s.updated_at,
	};
	return s.kind === 'reference'
		? {
				...base,
				ref: {
					backend: s.backend,
					locator: s.locator,
					...(s.expand ? { expand: s.expand } : {}),
					...(s.prefix ? { prefix: s.prefix } : {}),
				},
			}
		: base;
}
