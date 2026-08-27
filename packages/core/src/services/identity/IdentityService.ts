import type { Bucket } from '../../ports/bucket';
import { StaleWhileRevalidateCache } from '../../cache';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { NotFoundError, UnavailableError } from '../../errors';
import { foldCase, normalizeEmail } from '../../identityMatch';
import type { UserId } from '../../ids';
import type { AuthUser } from '../../ports/auth';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import { EmailAddressSchema, IdentitySchema, parseStored, readStored } from '../../schema';
import type { Identity } from '../../schema';
import { mutateObjectWithOutcome, withCasRetry } from '../catalog/cas';
import { listAllKeys } from '../catalog/storage';

/**
 * User-identity directory: maps a stable user id (the auth `sub`) to its current
 * `{ email, name, picture_url? }`. Records are upserted on each authenticated
 * request so they stay fresh, and resolved at read time to render opaque
 * `author`/`user_id` foreign keys as a person.
 *
 * IdentityService is the sole writer for each record. Profile and suspension
 * changes use ETag compare-and-swap so concurrent profile refreshes cannot
 * overwrite security state.
 */
export class IdentityService {
	// Per-process write-coalescing cache: id → last-written signature. Skips the
	// bucket PUT when an authenticated request carries an identity we've already
	// persisted this process, so the on-every-request upsert stays cheap. A
	// process restart simply re-writes once per user on their next request.
	private readonly written = new Map<string, string>();

	static readonly ACTIVE_SUSPENSION_FRESH_MS = 10_000;
	static readonly ACTIVE_SUSPENSION_MAX_AGE_MS = 30_000;
	static readonly SUSPENDED_FRESH_MS = 5 * 60_000;
	static readonly SUSPENSION_CACHE_MAX_SIZE = 10_000;
	private static readonly DIRECTORY_TTL_MS = 30_000;
	private static readonly DIRECTORY_CACHE_KEY = 'identity-directory';

	private readonly directory: StaleWhileRevalidateCache<string, Identity[]>;
	private readonly suspensions: StaleWhileRevalidateCache<UserId, boolean>;

	constructor(private bucket: Bucket) {
		this.directory = new StaleWhileRevalidateCache({
			load: () => this.scanDirectory(),
			maxSize: 1,
			ttl: () => ({ freshForMs: IdentityService.DIRECTORY_TTL_MS, staleForMs: Infinity }),
			onBackgroundError: (error) => {
				logOperationalError('identity_directory_refresh_failed', {}, error);
			},
		});
		this.suspensions = new StaleWhileRevalidateCache({
			load: (id) => this.loadSuspension(id),
			maxSize: IdentityService.SUSPENSION_CACHE_MAX_SIZE,
			ttl: (suspended) =>
				suspended
					? { freshForMs: IdentityService.SUSPENDED_FRESH_MS, staleForMs: Infinity }
					: {
							freshForMs: IdentityService.ACTIVE_SUSPENSION_FRESH_MS,
							staleForMs:
								IdentityService.ACTIVE_SUSPENSION_MAX_AGE_MS -
								IdentityService.ACTIVE_SUSPENSION_FRESH_MS,
						},
			onBackgroundError: (error, id) => {
				logOperationalError('identity_suspension_refresh_failed', { user_id: id }, error);
			},
		});
	}

	private static signature(email: string, name: string, pictureUrl?: string): string {
		return `${email}\0${name}\0${pictureUrl ?? ''}`;
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
		const email = EmailAddressSchema.parse(user.email);
		const name = IdentityService.displayName(user);
		const sig = IdentityService.signature(email, name, user.pictureUrl);
		if (this.written.get(user.id) === sig) return;

		const key = paths.identity(user.id);
		const record = await withCasRetry(this.bucket, async (cas) => {
			const obj = await this.bucket.get(key);
			const existing = obj ? await readStored(IdentitySchema, obj, key) : null;
			const next = IdentitySchema.parse({
				id: user.id,
				email,
				name,
				...(user.pictureUrl ? { picture_url: user.pictureUrl } : {}),
				...(existing?.suspended_at ? { suspended_at: existing.suspended_at } : {}),
				updated_at: new Date().toISOString(),
			});
			await cas.put(
				key,
				JSON.stringify(next),
				obj ? { onlyIfEtagMatches: obj.etag } : { onlyIfNotExists: true },
			);
			return next;
		});
		this.written.set(user.id, sig);
		this.updateCachedRecord(record);
	}

	async isSuspended(id: UserId): Promise<boolean> {
		return this.suspensions.get(id);
	}

	async setSuspension(id: UserId, suspended: boolean): Promise<Identity> {
		const key = paths.identity(id);
		const { value: record } = await mutateObjectWithOutcome(
			this.bucket,
			key,
			(raw) => parseStored(IdentitySchema, raw, key),
			(existing) => {
				if (suspended === Boolean(existing.suspended_at)) return null;
				return {
					...existing,
					...(suspended ? { suspended_at: new Date().toISOString() } : { suspended_at: undefined }),
				};
			},
			{ notFound: () => new NotFoundError(`User ${id} not found`) },
		);
		this.updateCachedRecord(record);
		return record;
	}

	private updateCachedRecord(record: Identity): void {
		this.directory.update(IdentityService.DIRECTORY_CACHE_KEY, (entries) => [
			...entries.filter((entry) => entry.id !== record.id),
			record,
		]);
		this.suspensions.set(record.id, record.suspended_at !== undefined);
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

	/**
	 * The full directory, served from the SWR cache. Records exist only for users
	 * who have signed in at least once.
	 */
	async list(): Promise<Identity[]> {
		return this.directory.get(IdentityService.DIRECTORY_CACHE_KEY);
	}

	private async loadSuspension(id: UserId): Promise<boolean> {
		try {
			return (await this.get(id))?.suspended_at !== undefined;
		} catch (error) {
			throw new UnavailableError('Unable to verify account suspension status', { cause: error });
		}
	}

	private async scanDirectory(): Promise<Identity[]> {
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
		return records.filter((record): record is Identity => record !== null);
	}

	/**
	 * Case-insensitive substring search over email, name, and id, for the
	 * add-member picker. Results are name-sorted for a stable UI.
	 */
	async search(query: string, limit = 10): Promise<Identity[]> {
		const q = foldCase(query);
		if (!q) return [];
		const all = await this.list();
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
		const matches = await this.findByEmail(email);
		if (matches.length === 0) return null;
		return matches.reduce((a, b) => (a.updated_at >= b.updated_at ? a : b));
	}

	async getUniqueByEmail(email: string): Promise<Identity | null> {
		const target = normalizeEmail(email);
		if (!target) return null;
		return (await this.getUniqueByEmails([target])).get(target) ?? null;
	}

	/**
	 * Resolve only unambiguous emails from a fresh directory scan. Claiming an
	 * invite is destructive, so the eventually consistent search cache is unsafe.
	 */
	async getUniqueByEmails(emails: readonly string[]): Promise<ReadonlyMap<string, Identity>> {
		const targets = new Set(emails.map(normalizeEmail).filter(Boolean));
		if (targets.size === 0) return new Map();
		const matches = new Map<string, Identity | null>();
		for (const identity of await this.scanDirectory()) {
			const email = normalizeEmail(identity.email);
			if (!targets.has(email)) continue;
			matches.set(email, matches.has(email) ? null : identity);
		}
		return new Map([...matches].filter((entry): entry is [string, Identity] => entry[1] !== null));
	}

	private async findByEmail(email: string): Promise<Identity[]> {
		const target = normalizeEmail(email);
		if (!target) return [];
		return (await this.list()).filter((identity) => normalizeEmail(identity.email) === target);
	}
}
