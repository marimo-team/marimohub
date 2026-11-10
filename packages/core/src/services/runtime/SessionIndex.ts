import type { Bucket } from '../../ports/bucket';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { listAllObjects } from '../catalog/storage';
import type { Session, SessionIndexRecord } from '../../schema';
import { readStored, SessionIndexSchema } from '../../schema';
import type { UserId } from '../../ids';
import { paths } from '../../paths';
import { withCasRetry } from '../catalog/cas';

export type SessionIndexMode = 'off' | 'shadow' | 'on';
export type SessionReference = SessionIndexRecord['entries'][number];

export class SessionIndex {
	constructor(private readonly bucket: Bucket) {}

	async read(userId: UserId): Promise<SessionIndexRecord> {
		return (await this.readWithEtag(userId)).value;
	}

	async listUsers(): Promise<UserId[]> {
		const objects = await listAllObjects(this.bucket, paths.sessionIndexPrefix);
		const records = await mapWithConcurrency(objects, BUCKET_SCAN_CONCURRENCY, (object) =>
			this.readObject(object.key),
		);
		return records.flatMap((record) => (record ? [record.value.user_id] : []));
	}

	private async readWithEtag(userId: UserId) {
		return (
			(await this.readObject(paths.sessionIndexForUser(userId))) ?? {
				value: { user_id: userId, entries: [] },
				etag: undefined,
			}
		);
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
		apply: (entries: SessionReference[]) => Promise<SessionReference[]>,
	): Promise<void> {
		const key = paths.sessionIndexForUser(userId);
		await withCasRetry(this.bucket, async (cas) => {
			const { value, etag } = await this.readWithEtag(userId);
			const entries = await apply(value.entries);
			await cas.put(
				key,
				JSON.stringify({ ...value, entries }),
				etag === undefined ? { onlyIfNotExists: true } : { onlyIfEtagMatches: etag },
			);
		});
	}

	async register(session: Session): Promise<void> {
		// Even an existing reference needs a CAS to fence concurrent reconciliation.
		await this.update(session.user_id, async (entries) => [
			...entries.filter((entry) => entry.session_id !== session.session_id),
			{ session_id: session.session_id, project_id: session.project_id },
		]);
	}

	async remove(session: Session): Promise<void> {
		await this.update(session.user_id, async (entries) =>
			entries.filter((entry) => entry.session_id !== session.session_id),
		);
	}
}
