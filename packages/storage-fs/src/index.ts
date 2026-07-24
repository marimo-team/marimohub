/**
 * `Bucket` adapter backed by a directory on the local filesystem (darwin/linux).
 *
 * Keys map 1:1 to relative paths under the root, so operators can browse the
 * tree directly. Traversal is blocked by key validation plus a resolved-path
 * containment check, and reads refuse a symlink as the final path component
 * (O_NOFOLLOW). Reads additionally re-resolve the real path and refuse anything
 * that escapes the root through an intermediate symlinked directory — a link
 * pointing outside the root reads as absent, not as the external file. Writes
 * stage into a reserved `.tmp/` dir (fsync, then rename into place — atomic on a
 * single filesystem).
 *
 * ETags are the sha-256 of the content, so they survive restarts (the catalog
 * compare-and-swap depends on that). `onlyIfNotExists` (hard link) is atomic
 * even across processes; `onlyIfEtagMatches` is only atomic within one process,
 * advertised via `casScope: 'process'` and surfaced by preflight as a startup
 * warning — never point two hub replicas at the same root.
 *
 * `httpMetadata`/`customMetadata` are accepted and ignored (parity with
 * MemoryBucket), and a key cannot be both an object and a prefix of another
 * (`a` vs `a/b`); marimohub's key layout never does this.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants, mkdirSync, realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { PreconditionFailedError } from '@marimo-hub/core';
import type {
	Bucket,
	BucketListOptions,
	BucketListResult,
	BucketObject,
	BucketObjectBody,
	BucketPutOptions,
} from '@marimo-hub/core/ports';

export interface FsStorageConfig {
	/** Host directory that confines all objects. Created if missing. */
	root: string;
}

/** Staging area for atomic writes; reserved — rejected as a key prefix and skipped by list(). */
const TMP_DIR = '.tmp';

/**
 * open() failures that mean "no object at this key": missing file, a file
 * where a directory was expected (ENOTDIR), a directory itself (EISDIR), a
 * symlink refused by O_NOFOLLOW (ELOOP on linux, EMLINK on darwin), or a key
 * segment longer than the filesystem name limit (ENAMETOOLONG — no such object
 * could ever exist, so treat it as absent rather than surfacing a raw errno).
 */
const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EMLINK', 'ENAMETOOLONG']);

/**
 * put() serialization shared by every instance in this process, keyed by
 * root + key — two FsStorage instances on one root must contend for the same
 * lock or `casScope: 'process'` would silently be instance-scoped.
 */
const putLocks = new Map<string, Promise<void>>();

function errCode(err: unknown): string | undefined {
	return err instanceof Error && 'code' in err
		? String((err as { code?: unknown }).code)
		: undefined;
}

function sha256hex(body: Uint8Array): string {
	return createHash('sha256').update(body).digest('hex');
}

function assertValidKey(key: string): void {
	if (key === '') throw new Error('Bucket key must be non-empty');
	if (key.includes('\0')) throw new Error('Invalid bucket key: contains a null byte');
	if (key.includes('\\')) throw new Error(`Invalid bucket key (keys are '/'-separated): "${key}"`);
	if (key.startsWith('/')) throw new Error(`Invalid bucket key (absolute path): "${key}"`);
	const segments = key.split('/');
	if (segments.some((s) => s === '' || s === '.' || s === '..')) {
		throw new Error(`Invalid bucket key (empty, "." or ".." segment): "${key}"`);
	}
	if (segments[0] === TMP_DIR) {
		throw new Error(`Invalid bucket key ("${TMP_DIR}/" is reserved): "${key}"`);
	}
}

export class FsStorage implements Bucket {
	/** CAS is per-process only; preflight reads this and downgrades its storage check to a warn. */
	readonly casScope = 'process' as const;

	private readonly root: string;
	/** `root` with a trailing separator (already present when root is `/`). */
	private readonly rootPrefix: string;
	private readonly tmpDir: string;

	constructor(config: FsStorageConfig) {
		mkdirSync(config.root, { recursive: true });
		this.root = realpathSync(config.root);
		this.rootPrefix = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
		this.tmpDir = path.join(this.root, TMP_DIR);
		mkdirSync(this.tmpDir, { recursive: true });
	}

	private resolvePath(key: string): string {
		assertValidKey(key);
		const abs = path.resolve(this.root, key);
		// assertValidKey already guarantees containment; defense in depth.
		if (!abs.startsWith(this.rootPrefix)) {
			throw new Error(`Bucket key escapes the storage root: "${key}"`);
		}
		return abs;
	}

	private async readObject(key: string): Promise<{ body: Buffer; uploaded: Date } | null> {
		const filePath = this.resolvePath(key);
		let handle: fsp.FileHandle;
		try {
			handle = await fsp.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (err) {
			if (NOT_FOUND_CODES.has(errCode(err) ?? '')) return null;
			throw err;
		}
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) return null;
			// O_NOFOLLOW only guards the final component; an intermediate symlinked
			// directory can still escape the root. Re-resolve the real path, refuse
			// anything outside the root, and require the opened fd to still be that same
			// inode (dev+ino) — so a static escaping symlink reads as absent.
			//
			// Threat model: this is defense-in-depth against a MISCONFIGURED tree (e.g.
			// an operator-mounted symlink escaping the root), NOT a race-free guarantee.
			// Node exposes no beneath-resolving open (openat2/RESOLVE_BENEATH), so an
			// attacker able to swap symlinks inside the root *concurrently* could still
			// win the open→realpath→stat window — but such an attacker already has write
			// access to the hub's private storage tree and has fully compromised it.
			let real: string;
			let realStat: Awaited<ReturnType<typeof fsp.stat>>;
			try {
				real = await fsp.realpath(filePath);
				if (real !== this.root && !real.startsWith(this.rootPrefix)) return null;
				realStat = await fsp.stat(real);
			} catch (err) {
				// The path vanished (or a segment did) after open — treat as absent so
				// list()'s concurrent-delete behavior stays intact.
				if (NOT_FOUND_CODES.has(errCode(err) ?? '')) return null;
				throw err;
			}
			if (realStat.ino !== stat.ino || realStat.dev !== stat.dev) return null;
			return { body: await handle.readFile(), uploaded: stat.mtime };
		} finally {
			await handle.close();
		}
	}

	async get(key: string): Promise<BucketObjectBody | null> {
		const read = await this.readObject(key);
		if (!read) return null;
		const { body, uploaded } = read;
		return {
			key,
			etag: sha256hex(body),
			size: body.length,
			uploaded,
			text: async () => new TextDecoder().decode(body),
			json: async <T>() => JSON.parse(new TextDecoder().decode(body)) as T,
			bytes: async () => body,
		};
	}

	async head(key: string): Promise<BucketObject | null> {
		const read = await this.readObject(key);
		if (!read) return null;
		return { key, etag: sha256hex(read.body), size: read.body.length, uploaded: read.uploaded };
	}

	private withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const lockKey = `${this.root}\0${key}`;
		const prev = putLocks.get(lockKey) ?? Promise.resolve();
		const run = prev.then(fn, fn);
		const chain = run.then(
			() => {},
			() => {},
		);
		putLocks.set(lockKey, chain);
		void chain.then(() => {
			if (putLocks.get(lockKey) === chain) putLocks.delete(lockKey);
		});
		return run;
	}

	async put(
		key: string,
		value: string | Uint8Array,
		options?: BucketPutOptions,
	): Promise<BucketObject> {
		const filePath = this.resolvePath(key);
		if (options?.onlyIfEtagMatches !== undefined && options?.onlyIfNotExists) {
			throw new Error('onlyIfEtagMatches and onlyIfNotExists are mutually exclusive');
		}
		return this.withKeyLock(key, async () => {
			const body = typeof value === 'string' ? new TextEncoder().encode(value) : value;
			const etag = sha256hex(body);
			const tmp = path.join(this.tmpDir, randomUUID());
			try {
				const handle = await fsp.open(tmp, 'wx');
				try {
					await handle.writeFile(body);
					// Flush to disk before the rename publishes the file, so a crash
					// can't leave a renamed-but-empty object behind.
					await handle.sync();
				} finally {
					await handle.close();
				}
				// rename/link preserve mtime, so stat the staged file for `uploaded`.
				const uploaded = (await fsp.stat(tmp)).mtime;
				await fsp.mkdir(path.dirname(filePath), { recursive: true });
				if (options?.onlyIfNotExists) {
					try {
						await fsp.link(tmp, filePath);
					} catch (err) {
						if (errCode(err) === 'EEXIST') {
							throw new PreconditionFailedError(`Key "${key}" already exists`);
						}
						throw err;
					}
				} else if (options?.onlyIfEtagMatches !== undefined) {
					const current = await this.readObject(key);
					if (!current || sha256hex(current.body) !== options.onlyIfEtagMatches) {
						throw new PreconditionFailedError(`ETag mismatch for key "${key}"`);
					}
					await fsp.rename(tmp, filePath);
				} else {
					await fsp.rename(tmp, filePath);
				}
				return { key, etag, size: body.length, uploaded };
			} finally {
				// ENOENT after a successful rename (the staged file was consumed).
				await fsp.unlink(tmp).catch(() => {});
			}
		});
	}

	async delete(key: string | string[]): Promise<void> {
		for (const k of Array.isArray(key) ? key : [key]) {
			const filePath = this.resolvePath(k);
			try {
				await fsp.unlink(filePath);
			} catch (err) {
				const code = errCode(err);
				if (code === 'ENOENT' || code === 'ENOTDIR') continue;
				// A key that resolves to a directory holds no object (get/head return
				// null), so deleting it is an idempotent no-op rather than a raw
				// EISDIR (linux) / EPERM (darwin). Only skip when it really is a dir —
				// a genuine permission fault on a file must still surface.
				if (code === 'EISDIR' || code === 'EPERM') {
					const st = await fsp.lstat(filePath).catch(() => null);
					if (!st || st.isDirectory()) continue;
				}
				throw err;
			}
			// Best-effort prune of now-empty parent dirs, stopping at the root.
			for (
				let dir = path.dirname(filePath);
				dir.startsWith(this.rootPrefix);
				dir = path.dirname(dir)
			) {
				try {
					await fsp.rmdir(dir);
				} catch {
					break;
				}
			}
		}
	}

	private async walkKeys(): Promise<string[]> {
		const entries = await fsp.readdir(this.root, { recursive: true, withFileTypes: true });
		const keys: string[] = [];
		for (const entry of entries) {
			// Symlinks are excluded here (isFile() is lstat-based for readdir entries),
			// so a link inside the root never surfaces in listings.
			if (!entry.isFile()) continue;
			const rel = path.relative(this.root, path.join(entry.parentPath, entry.name));
			const segKey = rel.split(path.sep).join('/');
			if (segKey.split('/')[0] === TMP_DIR) continue;
			keys.push(segKey);
		}
		return keys;
	}

	async list(options?: BucketListOptions): Promise<BucketListResult> {
		const prefix = options?.prefix ?? '';
		const delimiter = options?.delimiter;
		const limit = options?.limit ?? 1000;
		// Both `cursor` (resume token) and `startAfter` are exclusive lower bounds on
		// the key; honor whichever is larger.
		const after = [options?.cursor, options?.startAfter]
			.filter((v): v is string => Boolean(v))
			.sort()
			.pop();

		const sorted = (await this.walkKeys()).filter((k) => k.startsWith(prefix)).sort();

		const prefixes = new Set<string>();
		const objectKeys: string[] = [];
		for (const key of sorted) {
			if (after && key <= after) continue;
			if (delimiter) {
				const rest = key.slice(prefix.length);
				const idx = rest.indexOf(delimiter);
				if (idx !== -1) {
					prefixes.add(prefix + rest.slice(0, idx + delimiter.length));
					continue;
				}
			}
			objectKeys.push(key);
		}

		// Emulate S3/R2 paging for object listings: at most `limit` per page, with a
		// cursor to resume. Delimited (prefix-rollup) listings are returned whole.
		const pageKeys = delimiter ? objectKeys : objectKeys.slice(0, limit);
		const truncated = !delimiter && objectKeys.length > limit;

		const objects: BucketObject[] = [];
		for (const key of pageKeys) {
			const read = await this.readObject(key);
			// A file deleted between the walk and this read is silently skipped.
			if (!read) continue;
			objects.push({
				key,
				etag: sha256hex(read.body),
				size: read.body.length,
				uploaded: read.uploaded,
			});
		}

		return {
			objects,
			truncated,
			cursor: truncated ? pageKeys[pageKeys.length - 1] : undefined,
			delimitedPrefixes: [...prefixes].sort(),
		};
	}

	/**
	 * Boot self-check (called duck-typed by preflight): a wrong-etag put must be
	 * rejected, and concurrent CAS puts from one base etag yield at most one winner.
	 */
	async verifyConditionalWrites(): Promise<void> {
		// Unique per run so the probe can never clobber a real object.
		const probeKey = `_system/.cas-probe-${randomUUID()}`;

		await this.put(probeKey, 'v1');
		let rejected = false;
		try {
			await this.put(probeKey, 'v2', { onlyIfEtagMatches: 'this-etag-is-wrong' });
		} catch (err) {
			if (!(err instanceof PreconditionFailedError)) {
				await this.delete(probeKey).catch(() => {});
				throw err;
			}
			rejected = true;
		}
		if (!rejected) {
			await this.delete(probeKey).catch(() => {});
			throw new Error(
				'Filesystem storage CAS probe failed: a put with a wrong etag was accepted. The catalog ' +
					'compare-and-swap protocol is unsafe on this root.',
			);
		}

		const seed = await this.put(probeKey, 'v3');
		const N = 8;
		const results = await Promise.allSettled(
			Array.from({ length: N }, (_, i) =>
				this.put(probeKey, `r${i}`, { onlyIfEtagMatches: seed.etag }),
			),
		);
		await this.delete(probeKey).catch(() => {});
		for (const r of results) {
			if (r.status === 'rejected' && !(r.reason instanceof PreconditionFailedError)) throw r.reason;
		}
		const winners = results.filter((r) => r.status === 'fulfilled').length;
		if (winners > 1) {
			throw new Error(
				`Filesystem storage CAS probe failed: ${winners} concurrent conditional puts from the ` +
					'same etag were accepted (expected at most 1).',
			);
		}
	}
}
