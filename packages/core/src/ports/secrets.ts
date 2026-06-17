/**
 * Port: project-scoped third-party secrets (e.g. `OPENAI_API_KEY`, a DB password)
 * injected into a notebook sandbox as env vars. An entry is one of two kinds:
 *
 * - `managed` — the hub holds the value (encrypted at rest via a `ManagedSecretCodec`).
 * - `reference` — the value lives in an external manager (AWS Secrets Manager, Vault,
 *   GCP); the hub stores only a pointer and dereferences it at provision time.
 *
 * `core` and the API depend only on these interfaces; concrete resolvers live in
 * `packages/secrets-*` adapters wired by `config`. No route ever returns a managed
 * value; a reference locator (not sensitive) may be returned so the UI can show it.
 */
import type { ProjectId, UserId } from '../ids';

export type SecretKind = 'managed' | 'reference';

/** A pointer to a value held in an external secret manager. NOT sensitive. */
export interface SecretRef {
	/** Selects a registered SecretResolver, e.g. `aws-sm`. */
	backend: string;
	/** Manager-specific, e.g. `prod/ai#OPENAI_API_KEY` or an ARN[#key]. */
	locator: string;
	/**
	 * When `'json'`, the resolved value is a JSON object whose keys each become an
	 * injected env var (ESO's `dataFrom.extract`) — the store fans it out; the
	 * resolver is unaware. The `locator` should address the whole secret (no `#key`).
	 */
	expand?: 'json';
	/** Optional prefix applied to each fanned-out key (only with `expand: 'json'`). */
	prefix?: string;
}

/** Everything about an entry EXCEPT a managed value (never leaves the server). */
export interface SecretEntryMeta {
	/** Env var injected into the sandbox. */
	name: string;
	kind: SecretKind;
	/** Present iff `kind === 'reference'` (safe to return over the API). */
	ref?: SecretRef;
	created_by: UserId;
	created_at: string;
	updated_at: string;
}

export type SecretInput =
	| { kind: 'managed'; value: string }
	| { kind: 'reference'; ref: SecretRef };

export interface SecretsProvider {
	/** Names + metadata (+ reference locators). NEVER a managed value. */
	list(projectId: ProjectId): Promise<SecretEntryMeta[]>;
	/** Create/overwrite an entry (a managed value is write-only). */
	put(
		projectId: ProjectId,
		name: string,
		input: SecretInput,
		actor: UserId,
	): Promise<SecretEntryMeta>;
	/** Idempotent (deleting a missing name is a no-op). */
	delete(projectId: ProjectId, name: string): Promise<void>;
	/**
	 * Test that an input resolves, WITHOUT persisting it — for add-time feedback.
	 * Throws the resolver's non-leaking error on failure (never the value/locator
	 * secret material). A no-op for `managed` input.
	 */
	validate(input: SecretInput): Promise<void>;
	/**
	 * Resolve ALL of a project's entries to plaintext for injection. SERVER-SIDE
	 * ONLY — called by the provisioning route, never reachable from any HTTP read.
	 * MUST throw (naming the entry, without leaking the value) on any resolve
	 * failure — a load-bearing key must never be silently absent.
	 */
	resolve(projectId: ProjectId): Promise<Record<string, string>>;
}

/** Dereferences ONE reference. Implemented by `packages/secrets-*` adapters. */
export interface SecretResolver {
	/** Matches `SecretRef.backend`. */
	readonly backend: string;
	/** → plaintext. MUST throw (naming the ref, WITHOUT leaking it) on failure. */
	resolve(ref: SecretRef): Promise<string>;
}

/** Envelope for a hub-held (managed) value — ciphertext only, no plaintext at rest. */
export interface SecretEnvelope {
	kek_id: string;
	alg: 'A256GCM';
	/** base64 */
	iv: string;
	/** base64 */
	ciphertext: string;
}

/**
 * Crypto for `managed` entries — implemented by the encrypted-in-bucket codec. The
 * store owns bucket I/O and passes the secret's `path` as context so no two secrets
 * share a key/IV derivation.
 */
export interface ManagedSecretCodec {
	encrypt(plaintext: string, context: { path: string }): Promise<SecretEnvelope>;
	decrypt(envelope: SecretEnvelope, context: { path: string }): Promise<string>;
}
