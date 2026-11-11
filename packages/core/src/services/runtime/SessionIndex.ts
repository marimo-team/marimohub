import { ConflictError } from '../../errors';
import type { Bucket } from '../../ports/bucket';
import { listAllKeys } from '../catalog/storage';
import type { Session, SessionIndexRecord } from '../../schema';
import { readStored, SessionIndexSchema } from '../../schema';
import { UserId } from '../../ids';
import { paths } from '../../paths';
import { withCasRetry } from '../catalog/cas';

export type SessionReference = SessionIndexRecord['entries'][number];

export class SessionIndex {
	constructor(private readonly bucket: Bucket) {}

	async read(userId: UserId): Promise<SessionIndexRecord | null> {
		return (await this.readObject(paths.sessionIndexForUser(userId)))?.value ?? null;
	}

	/** Decoded from keys; each index's `user_id` is checked when it is next read. */
	async listUsers(): Promise<UserId[]> {
		const keys = await listAllKeys(this.bucket, paths.sessionIndexPrefix);
		return keys.map((key) => {
			const name = key.slice(paths.sessionIndexPrefix.length);
			const userId = UserId.parse(decodeURIComponent(name.replace(/\.json$/, '')));
			if (paths.sessionIndexForUser(userId) !== key)
				throw new Error('Session index owner mismatch');
			return userId;
		});
	}

	private async readObject(key: string) {
		const object = await this.bucket.get(key);
		if (!object) return null;
		const value = await readStored(SessionIndexSchema, object, key);
		if (key !== paths.sessionIndexForUser(value.user_id))
			throw new Error('Session index owner mismatch');
		return { value, etag: object.etag };
	}

	async update(
		userId: UserId,
		apply: (entries: SessionReference[], exists: boolean) => Promise<SessionReference[] | null>,
		options: { requireExisting?: boolean; skipUnchanged?: boolean } = {},
	): Promise<void> {
		const key = paths.sessionIndexForUser(userId);
		await withCasRetry(this.bucket, async (cas) => {
			const record = await this.readObject(key);
			if (!record && options.requireExisting)
				throw new ConflictError('Session index is missing; retry to rebuild it');
			const value = record?.value ?? { user_id: userId, entries: [] };
			const etag = record?.etag;
			const entries = await apply(value.entries, record !== null);
			if (entries === null) return;
			if (record && options.skipUnchanged && sameSessionReferences(value.entries, entries)) return;
			await cas.put(
				key,
				JSON.stringify({ ...value, entries }),
				etag === undefined ? { onlyIfNotExists: true } : { onlyIfEtagMatches: etag },
			);
		});
	}

	/**
	 * Only a missing index is built from `initialEntries`. Once an index has been seen,
	 * its disappearance rejects the registration instead of rebuilding it.
	 */
	async register(
		session: Session,
		initialEntries: () => Promise<SessionReference[]>,
	): Promise<void> {
		let initialized = false;
		// Even an existing reference needs a CAS to fence concurrent reconciliation.
		// It keeps its position: entry order is the cap admission order.
		await this.update(session.user_id, async (current, exists) => {
			if (exists) initialized = true;
			else if (initialized)
				throw new ConflictError('Session index is missing; retry to rebuild it');
			const entries = exists ? current : await initialEntries();
			return entries.some((entry) => entry.session_id === session.session_id)
				? entries
				: [...entries, { session_id: session.session_id, project_id: session.project_id }];
		});
	}
}

export function sameSessionReferences(a: SessionReference[], b: SessionReference[]): boolean {
	if (a.length !== b.length) return false;
	const projects = new Map(a.map((entry) => [entry.session_id, entry.project_id]));
	return b.every((entry) => projects.get(entry.session_id) === entry.project_id);
}
