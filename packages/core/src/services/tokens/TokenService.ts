import type { Bucket, BucketObjectBody } from '../../ports/bucket';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { NotFoundError, PreconditionFailedError, ResourceExhaustedError } from '../../errors';
import { createTokenId, TokenId } from '../../ids';
import type { UserId } from '../../ids';
import { timingSafeEqual } from '../../internal/hmac';
import { toHex } from '../../internal/hex';
import type { AuthUser } from '../../ports/auth';
import { paths } from '../../paths';
import { logOperationalError } from '../../operationalLog';
import { readStored, TokenSchema, toPublicToken } from '../../schema';
import type { PublicToken, Token } from '../../schema';
import { listAllKeys } from '../catalog/storage';
import type { IdentityService } from '../identity/IdentityService';

/**
 * Personal access token format: `mhub_pat_<tokenId>_<secret>`. The fixed
 * prefix exists for secret-scanner registration; the embedded ULID id makes
 * verification a single GET (no scan, no index object); the 32-char base32
 * secret carries 160 bits of entropy.
 */
export const PAT_PREFIX = 'mhub_pat_';

const PAT_RE = /^mhub_pat_([0-9A-Z]{26})_([0-9a-z]{32})$/;

/** Secret alphabet/length mirror the random ids in ids.ts: 32 chars × 5 bits = 160 bits. */
const SECRET_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const SECRET_LENGTH = 32;

/** Whether a bearer credential is (claims to be) a personal access token. */
export function isPersonalAccessToken(bearer: string): boolean {
	return bearer.startsWith(PAT_PREFIX);
}

/**
 * The bearer credential from a request's `Authorization` header, or null. The
 * scheme match is case-insensitive (`Bearer`/`bearer`/`BEARER` all parse), so
 * every consumer sees the same value — anything that re-derives "is this a PAT
 * request?" with a stricter rule would let a differently-cased scheme slip past.
 */
export function bearerToken(request: Request): string | null {
	const header = request.headers.get('authorization');
	if (!header) return null;
	const [scheme, ...rest] = header.split(' ');
	if (scheme.toLowerCase() !== 'bearer') return null;
	const token = rest.join(' ').trim();
	return token || null;
}

/** Whether a request authenticates with a personal access token. */
export function isPatRequest(request: Request): boolean {
	const bearer = bearerToken(request);
	return bearer !== null && isPersonalAccessToken(bearer);
}

function generateSecret(): string {
	const bytes = new Uint8Array(SECRET_LENGTH);
	crypto.getRandomValues(bytes);
	let out = '';
	for (let i = 0; i < SECRET_LENGTH; i++) {
		out += SECRET_ALPHABET[bytes[i] & 31];
	}
	return out;
}

/** Lowercase-hex SHA-256 of a token secret — the only form ever persisted. */
export async function hashPatSecret(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
	return toHex(new Uint8Array(digest));
}

/**
 * Parse a stored token object, tolerating BOTH non-JSON bytes and schema drift —
 * a single corrupt record must never take down verify/list/revoke (it just reads
 * as an invalid credential). Returns null on any failure.
 */
async function parseTokenBody(obj: BucketObjectBody, key: string): Promise<Token | null> {
	try {
		return await readStored(TokenSchema, obj, key);
	} catch (err) {
		logOperationalError('stored_object_skipped', { operation: 'token.read', object: key }, err);
		return null;
	}
}

/** Whether a token is still live at `nowMs` (a missing expiry never expires). */
function isLive(token: { expires_at?: string }, nowMs: number): boolean {
	return token.expires_at === undefined || new Date(token.expires_at).getTime() > nowMs;
}

export interface CreateTokenInput {
	name: string;
	/** Days until expiry; omitted = the token never expires. */
	expiresInDays?: number;
}

export interface CreatedToken {
	/** The full plaintext token. Returned exactly once — it is never stored. */
	token: string;
	record: PublicToken;
}

/**
 * Personal access tokens: bucket-only machine credentials that act as their
 * issuing user. `verify` is the request hot path, so positive verifications are
 * cached per process with a short TTL (the same doctrine as IdentityService's
 * directory cache). Revocation deletes the per-token object; other replicas
 * keep honoring a revoked token for at most the cache TTL.
 */
export class TokenService {
	/** Per-user cap on live tokens — an abuse guard, not a capacity limit. */
	static readonly MAX_TOKENS_PER_USER = 20;
	/** Positive-cache TTL; bounds the cross-replica revocation lag. */
	static readonly CACHE_TTL_MS = 30_000;

	// Positive cache only: token id → verified record + resolved user + the object
	// ETag at load time (so `touch` can write conditionally). Failed lookups are
	// never cached, so garbage ids cannot grow the map.
	private readonly cache = new Map<
		TokenId,
		{ record: Token; user: AuthUser; etag: string; at: number }
	>();

	constructor(
		private bucket: Bucket,
		private identities: IdentityService,
	) {}

	async create(input: CreateTokenInput, userId: UserId): Promise<CreatedToken> {
		const nowMs = Date.now();
		// The cap counts only LIVE tokens — an expired record still lists (as
		// metadata) but must not block minting a replacement. Best-effort: concurrent
		// mints can each read a below-limit count and race past it (no CAS on a fresh
		// key). It's an abuse guard, not a quota.
		const live = (await this.list(userId)).filter((t) => isLive(t, nowMs));
		if (live.length >= TokenService.MAX_TOKENS_PER_USER) {
			throw new ResourceExhaustedError(
				`Token limit reached (${TokenService.MAX_TOKENS_PER_USER} per user) — revoke an unused token first`,
			);
		}

		const id = createTokenId();
		const secret = generateSecret();
		const now = new Date(nowMs);
		const record: Token = {
			id,
			user_id: userId,
			name: input.name,
			hash: await hashPatSecret(secret),
			created_at: now.toISOString(),
			...(input.expiresInDays !== undefined
				? {
						expires_at: new Date(
							now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000,
						).toISOString(),
					}
				: {}),
		};
		await this.bucket.put(paths.token(id), JSON.stringify(record));
		return { token: `${PAT_PREFIX}${id}_${secret}`, record: toPublicToken(record) };
	}

	/**
	 * A user's tokens (metadata only — never hashes), newest first. Cost is
	 * O(all tokens in the deployment): the flat keyspace is keyed by token id so
	 * `verify` is a single GET, which rules out a per-user prefix here without a
	 * separate mutable index (which the store's single-CAS-object invariant
	 * forbids). Acceptable because listing/creating are cold self-service paths,
	 * bounded by users × MAX_TOKENS_PER_USER — not the request hot path.
	 */
	async list(userId: UserId): Promise<PublicToken[]> {
		const keys = await listAllKeys(this.bucket, paths.tokensPrefix);
		const records = await mapWithConcurrency(keys, BUCKET_SCAN_CONCURRENCY, async (key) => {
			const obj = await this.bucket.get(key);
			return obj ? parseTokenBody(obj, key) : null;
		});
		return records
			.filter((r): r is Token => r?.user_id === userId)
			.sort((a, b) => b.id.localeCompare(a.id)) // ULID ids sort by creation time
			.map(toPublicToken);
	}

	/**
	 * Revoke one of `userId`'s tokens. 404 for a token that does not exist OR
	 * belongs to someone else — ownership of other users' token ids is not
	 * disclosed.
	 */
	async revoke(userId: UserId, tokenId: TokenId): Promise<void> {
		const obj = await this.bucket.get(paths.token(tokenId));
		// A corrupt record can't prove ownership and already fails `verify`, so treat
		// it as not-found rather than 500ing a security-relevant "make it stop
		// working" call.
		const record = obj ? await parseTokenBody(obj, paths.token(tokenId)) : null;
		if (!record || record.user_id !== userId) {
			throw new NotFoundError(`Token ${tokenId} not found`);
		}
		await this.bucket.delete(paths.token(tokenId));
		// Same-process revocation is immediate; other replicas age out via the TTL.
		this.cache.delete(tokenId);
	}

	/**
	 * Resolve a presented bearer credential to its issuing user, or null for
	 * anything invalid (malformed, unknown, wrong secret, expired, revoked, or an
	 * issuer with no identity record). Never throws — the auth middleware maps
	 * null to 401.
	 */
	async verify(bearer: string): Promise<AuthUser | null> {
		const match = PAT_RE.exec(bearer);
		if (!match) return null;
		const tokenId = TokenId.parse(match[1]);
		const secret = match[2];

		const entry = await this.load(tokenId);
		if (!entry) return null;
		const { record, user } = entry;

		// Constant-time compare of the secret's hash. An unknown token id returns
		// earlier (id-existence is not hidden), but the 160-bit secret is what
		// gates access, and comparing it in constant time defeats a timing probe.
		const encoder = new TextEncoder();
		const presented = encoder.encode(await hashPatSecret(secret));
		if (!timingSafeEqual(presented, encoder.encode(record.hash))) return null;

		// Expired when the deadline is now or already past.
		if (record.expires_at !== undefined && new Date(record.expires_at).getTime() <= Date.now()) {
			this.cache.delete(tokenId);
			return null;
		}

		await this.touch(entry);
		return user;
	}

	/** Cached entry for a token id, refreshing from the bucket past the TTL. */
	private async load(tokenId: TokenId): Promise<CacheEntry | null> {
		const cached = this.cache.get(tokenId);
		if (cached && Date.now() - cached.at < TokenService.CACHE_TTL_MS) return cached;

		const obj = await this.bucket.get(paths.token(tokenId));
		if (!obj) {
			this.cache.delete(tokenId);
			return null;
		}
		const record = await parseTokenBody(obj, paths.token(tokenId));
		if (!record) return null;

		// Resolve `{email, name}` through the identity directory — every issuer has
		// signed in at least once, which recorded them. Fail closed if it's gone.
		const identity = await this.identities.get(record.user_id);
		if (!identity) return null;
		const entry: CacheEntry = {
			record,
			user: { id: identity.id, email: identity.email, name: identity.name },
			etag: obj.etag,
			at: Date.now(),
		};
		this.cache.set(tokenId, entry);
		return entry;
	}

	/**
	 * Refresh `last_used_at`, coalesced to once per UTC day so the hot path is
	 * not a bucket PUT per request. The write is conditional on the ETag read at
	 * load time (`If-Match`): if the token was revoked (deleted) or rewritten
	 * concurrently, the CAS fails and we do NOT recreate the object — an
	 * unconditional PUT here would resurrect a just-revoked token. Best-effort: a
	 * failed write (incl. the lost CAS) must never fail an otherwise-valid auth.
	 */
	private async touch(entry: CacheEntry): Promise<void> {
		const now = new Date().toISOString();
		if (entry.record.last_used_at?.slice(0, 10) === now.slice(0, 10)) return;
		const updated: Token = { ...entry.record, last_used_at: now };
		try {
			const written = await this.bucket.put(paths.token(entry.record.id), JSON.stringify(updated), {
				onlyIfEtagMatches: entry.etag,
			});
			// Keep the cache coherent so a same-process re-verify uses the new ETag.
			entry.record = updated;
			entry.etag = written.etag;
		} catch (err) {
			if (err instanceof PreconditionFailedError) return;
			logOperationalError(
				'token_usage_touch_failed',
				{ operation: 'token.touch', object: paths.token(entry.record.id) },
				err,
			);
			// Usage bookkeeping only — swallow and keep serving the request.
		}
	}
}

interface CacheEntry {
	record: Token;
	user: AuthUser;
	etag: string;
	at: number;
}
