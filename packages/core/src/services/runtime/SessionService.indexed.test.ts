import { describe, expect, it, vi } from 'vitest';
import { ProjectId, NotebookId, UserId } from '../../ids';
import { MemoryBucket } from '../../testing/MemoryBucket';
import type { IndexedSessionRecords } from '../../ports/metadata';
import type { Session } from '../../schema';
import { SessionService } from './SessionService';

function queryPort(bucket: MemoryBucket): IndexedSessionRecords {
	return {
		list: vi.fn(async (query) => {
			const page = await bucket.list({ prefix: '_system/sessions/' });
			const bodies = await Promise.all(page.objects.map((object) => bucket.get(object.key)));
			const candidates = [];
			for (const body of bodies) {
				if (!body) continue;
				const record = await body.json<Session>();
				if (query.projectId && query.projectId !== record.project_id) continue;
				if (query.userId && query.userId !== record.user_id) continue;
				candidates.push(body);
			}
			const offset = Number(query.cursor ?? 0);
			return {
				records: candidates.slice(offset, offset + 2),
				...(offset + 2 < candidates.length ? { cursor: String(offset + 2) } : {}),
			};
		}),
	};
}

describe('indexed session candidates', () => {
	it('preserves project listings and cap policy across all candidate pages without record GETs', async () => {
		const bucket = new MemoryBucket();
		const baseline = new SessionService(bucket);
		const pid = ProjectId.create();
		const nid = NotebookId.create();
		const uid = UserId.parse('owner');
		for (let i = 0; i < 6; i++) {
			await baseline.createSession({
				project_id: pid,
				notebook_id: nid,
				user_id: uid,
				mode: i % 2 ? 'app' : 'edit',
			});
		}
		const query = queryPort(bucket.clone());
		const indexed = new SessionService(bucket, undefined, undefined, () => false, query);
		const expectedProject = await baseline.listActiveByProject(pid);
		const expectedUser = await baseline.listActiveForUser(uid);
		const get = vi.spyOn(bucket, 'get');
		expect(await indexed.listActiveByProject(pid)).toEqual(expectedProject);
		expect(await indexed.listActiveForUser(uid)).toEqual(expectedUser);
		expect(get).not.toHaveBeenCalled();
		expect(query.list).toHaveBeenCalledWith(expect.objectContaining({ projectId: pid }));
		expect(query.list).toHaveBeenCalledWith(expect.objectContaining({ userId: uid, cursor: '4' }));
	});
});
