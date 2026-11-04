import { describe, expect, it } from 'vitest';
import { ProjectId, UserId } from '../../ids';
import { MemoryBucket } from '../../testing/MemoryBucket';
import { paths } from '../../paths';
import { ChatPermissionStore } from './ChatPermissionStore';

const pid = ProjectId.parse('proj-0000000000000000');
const alice = UserId.parse('alice');
const bob = UserId.parse('bob');

describe('ChatPermissionStore', () => {
	it('remembers one grant per scope, privately per user', async () => {
		const store = new ChatPermissionStore(new MemoryBucket());
		const first = await store.grant(pid, alice, {
			kind: 'tool',
			scope_key: 'tool:create_notebook',
			scope_label: 'creating notebooks',
			action: 'Create a notebook',
		});
		const second = await store.grant(pid, alice, {
			kind: 'tool',
			scope_key: 'tool:create_notebook',
			scope_label: 'creating notebooks',
			action: 'Create a notebook',
		});
		expect((await store.list(pid, alice)).map((grant) => grant.id)).toEqual([second.id]);
		expect(await store.find(pid, alice, 'tool', 'tool:create_notebook')).toMatchObject({
			id: second.id,
		});
		expect(await store.find(pid, alice, 'tool', 'tool:run_job')).toBeUndefined();
		expect(await store.list(pid, bob)).toEqual([]);
		expect(first.id).not.toBe(second.id);
	});

	it('revokes grants, reports whether one was removed, and leaves the record alone otherwise', async () => {
		const bucket = new MemoryBucket();
		const store = new ChatPermissionStore(bucket);
		const grant = await store.grant(pid, alice, {
			kind: 'tool',
			scope_key: 'tool:run_job',
			scope_label: 'running jobs',
			action: 'Run a job',
		});
		expect(await store.revoke(pid, alice, grant.id)).toBe(true);
		const key = paths.chatPermissions(pid, alice);
		const etag = (await bucket.head(key))?.etag;
		expect(await store.revoke(pid, alice, grant.id)).toBe(false);
		expect((await bucket.head(key))?.etag).toBe(etag);
		expect(await store.list(pid, alice)).toEqual([]);
		expect(await store.revoke(pid, bob, grant.id)).toBe(false);
		expect(await bucket.head(paths.chatPermissions(pid, bob))).toBeNull();
	});

	it('keeps the newest 200 grants', async () => {
		const store = new ChatPermissionStore(new MemoryBucket());
		for (let index = 0; index < 205; index++)
			await store.grant(pid, alice, {
				kind: 'tool',
				scope_key: `scope:${index}`,
				scope_label: `scope ${index}`,
				action: 'Act',
			});
		const grants = await store.list(pid, alice);
		expect(grants).toHaveLength(200);
		expect(grants[0]?.scope_key).toBe('scope:5');
	});
});
