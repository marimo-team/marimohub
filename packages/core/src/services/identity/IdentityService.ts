import type { Bucket } from '../../ports/bucket';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { foldCase, normalizeEmail } from '../../identityMatch';
import type { UserId } from '../../ids';
import type { AuthUser } from '../../ports/auth';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import { IdentitySchema, readStored } from '../../schema';
import type { Identity } from '../../schema';
import { listAllKeys } from '../catalog/storage';

/**
 * User-identity directory: maps a stable user id (the auth `sub`) to its current
 * `{ email, name }`. Records are upserted on each authenticated request so they
 * stay fresh, and resolved at read time to render opaque `author`/`user_id`
 * foreign keys as a person.
 *
 * Unlike the rest of the store (immutable / append-only content + the
 * CAS-guarded catalog pointer), an identity object is mutable and last-writer-
 * wins: a plain overwrite of a single per-user key. Concurrent logins for the
 * same user converge on whichever write lands last, which is exactly the desired
 * "latest known identity" semantics.
 */
export class IdentityService {
	// Per-process write-coalescing cache: id → last-written signature. Skips the
	// bucket PUT when an authenticated request carries an identity we've already
	// persisted this process, so the on-every-request upsert stays cheap. A
	// process restart simply re-writes once per user on their next request.
	private readonly written = new Map<string, string>();

	// Per-process directory cache backing search/getByEmail. A full refresh is a
	// prefix list + one GET per identity (O(N) — fine to low thousands of users;
	// past that the directory needs a real index, which would have to be per-key
	// writes to respect the single-CAS-object invariant). Expiry is
	// stale-while-revalidate: a lapsed TTL serves the old entries and refreshes in
	// the background, so only the very first call ever blocks on the scan, and
	// concurrent refreshes are single-flighted. `upsert` splices its record into
	// the warm cache so a just-signed-in user is immediately resolvable.
	// Per-isolate staleness on Workers is acceptable for the same reason
	// `written` is.
	private directory: { at: number; entries: Identity[] } | null = null;
	private refreshing: Promise<Identity[]> | null = null;
	private static readonly DIRECTORY_TTL_MS = 30_000;

	constructor(private bucket: Bucket) {}

	private static signature(email: string, name: string): string {
		return `${email}\0${name}`;
	}

	/** Display name for a user, falling back to the email local-part. */
	private static displayName(user: AuthUser): string {
		const name = user.name?.trim();
		if (name) return name;
		const at = user.email.indexOf('@');
		return at > 0 ? user.email.slice(0, at) : user.email;
	}

	/**
	 * Record (or refresh) a user's identity. No-op when the identity is unchanged
	 * since this process last wrote it. Best-effort: callers run this off the auth
	 * path and must not let a failure block the request.
	 */
	async upsert(user: AuthUser): Promise<void> {
		const name = IdentityService.displayName(user);
		const sig = IdentityService.signature(user.email, name);
		if (this.written.get(user.id) === sig) return;

		const record: Identity = {
			id: user.id,
			email: user.email,
			name,
			updated_at: new Date().toISOString(),
		};
		await this.bucket.put(paths.identity(user.id), JSON.stringify(record));
		this.written.set(user.id, sig);
		// Keep the directory cache coherent with what this process just wrote, so
		// an admin can resolve this user by email (add-by-email canonicalization,
		// search) without waiting out the TTL.
		if (this.directory) {
			this.directory.entries = [
				...this.directory.entries.filter((e) => e.id !== record.id),
				record,
			];
		}
	}

	/** Resolve a single identity, or null when none has been recorded. */
	async get(id: UserId): Promise<Identity | null> {
		const obj = await this.bucket.get(paths.identity(id));
		if (!obj) return null;
		return readStored(IdentitySchema, obj, paths.identity(id));
	}

	/**
	 * Resolve many identities at once. Ids are de-duplicated, fetched in parallel,
	 * and unknown ids are silently omitted — the result is a sparse list the
	 * caller indexes by `id`.
	 */
	async getMany(ids: UserId[]): Promise<Identity[]> {
		const unique = [...new Set(ids)];
		const results = await Promise.all(unique.map((id) => this.get(id)));
		return results.filter((r): r is Identity => r !== null);
	}

	private async listAll(): Promise<Identity[]> {
		if (this.directory && Date.now() - this.directory.at < IdentityService.DIRECTORY_TTL_MS) {
			return this.directory.entries;
		}
		// Single-flight: concurrent misses share one scan instead of each running
		// their own list + N GETs.
		if (!this.refreshing) {
			this.refreshing = this.refresh().finally(() => {
				this.refreshing = null;
			});
			if (this.directory) {
				this.refreshing.catch((err) => {
					logOperationalError('identity_directory_refresh_failed', {}, err);
				});
			}
		}
		if (this.directory) {
			// Stale-while-revalidate: 30s staleness is already accepted, so don't
			// make a keystroke-driven search pay the full rescan latency. A failed
			// background refresh keeps serving the stale entries.
			return this.directory.entries;
		}
		return this.refreshing;
	}

	private async refresh(): Promise<Identity[]> {
		const keys = await listAllKeys(this.bucket, paths.identitiesPrefix);
		const records = await mapWithConcurrency(keys, BUCKET_SCAN_CONCURRENCY, async (key) => {
			const obj = await this.bucket.get(key);
			if (!obj) return null;
			// Tolerate corrupt records (like getMany): one bad object must not take
			// down search for the whole directory.
			try {
				return await readStored(IdentitySchema, obj, key);
			} catch (err) {
				logOperationalError(
					'stored_object_skipped',
					{ operation: 'identity.directory_scan', object: key },
					err,
				);
				return null;
			}
		});
		const entries = records.filter((r): r is Identity => r !== null);
		this.directory = { at: Date.now(), entries };
		return entries;
	}

	/**
	 * Case-insensitive substring search over email, name, and id, for the
	 * add-member picker. Results are name-sorted for a stable UI.
	 */
	async search(query: string, limit = 10): Promise<Identity[]> {
		const q = foldCase(query);
		if (!q) return [];
		const all = await this.listAll();
		return all
			.filter(
				(u) =>
					foldCase(u.email).includes(q) ||
					foldCase(u.name).includes(q) ||
					foldCase(u.id).includes(q),
			)
			.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
			.slice(0, limit);
	}

	/**
	 * Resolve an email to an identity (case-insensitive), or null if that email
	 * has never logged in. Ids are the primary key, so two subs can share an
	 * email (e.g. after an auth-backend migration); the most recently refreshed
	 * record wins.
	 */
	async getByEmail(email: string): Promise<Identity | null> {
		const target = normalizeEmail(email);
		if (!target) return null;
		const all = await this.listAll();
		const matches = all.filter((u) => normalizeEmail(u.email) === target);
		if (matches.length === 0) return null;
		return matches.reduce((a, b) => (a.updated_at >= b.updated_at ? a : b));
	}
}
