import { describe, expect, it, vi } from 'vitest';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { UserId } from '../../ids';
import { PreconditionFailedError } from '../../errors';
import { paths } from '../../paths';
import { AuthInvitationService } from './AuthInvitationService';

describe('AuthInvitationService', () => {
	it('persists exact-email invitations, normalizes casing, and revokes across replicas', async () => {
		const bucket = new MemoryBucket();
		const service = new AuthInvitationService(bucket);
		const other = new AuthInvitationService(bucket);
		const invitation = await service.invite(' Guest@Outside.com ', UserId.parse('admin'));
		expect(invitation.email).toBe('guest@outside.com');
		expect(await other.get('GUEST@outside.com')).toEqual(invitation);
		expect(await other.get('someone@outside.com')).toBeNull();
		expect(await service.invite('guest@outside.com', UserId.parse('another-admin'))).toEqual(
			invitation,
		);
		expect(await other.list()).toEqual([invitation]);
		await other.revoke('GUEST@OUTSIDE.COM');
		expect(await service.get('guest@outside.com')).toBeNull();
		expect(await service.list()).toEqual([]);
	});

	it('deduplicates concurrent invitations', async () => {
		const bucket = new MemoryBucket();
		const services = [new AuthInvitationService(bucket), new AuthInvitationService(bucket)];
		const records = await Promise.all(
			services.map((service, i) => service.invite('guest@outside.com', UserId.parse(`admin-${i}`))),
		);
		expect(records[0]).toEqual(records[1]);
		expect(await services[0].list()).toHaveLength(1);
	});

	it('rejects invalid addresses and fails closed on unreadable storage', async () => {
		const bucket = new MemoryBucket();
		const service = new AuthInvitationService(bucket);
		await expect(service.invite('not-an-email', UserId.parse('admin'))).rejects.toThrow();
		await bucket.put(paths.authInvitation('guest@outside.com'), '{}');
		await expect(service.get('guest@outside.com')).rejects.toThrow();
		vi.spyOn(bucket, 'get').mockRejectedValue(new Error('storage unavailable'));
		await expect(service.get('guest@outside.com')).rejects.toThrow('storage unavailable');
	});
});

describe('invitation failure paths', () => {
	const actor = UserId.parse('admin');
	const email = 'guest@outside.com';

	it.each([
		'',
		'   ',
		'a@@outside.com',
		'a b@outside.com',
		'a\u0000@outside.com',
		`${'a'.repeat(309)}@outside.com`,
	])('does not write invalid input %j', async (invalid) => {
		const bucket = new MemoryBucket();
		const write = vi.spyOn(bucket, 'put');
		await expect(new AuthInvitationService(bucket).invite(invalid, actor)).rejects.toThrow();
		expect(write).not.toHaveBeenCalled();
	});

	it('keeps plus aliases distinct and safely stores path characters', async () => {
		const service = new AuthInvitationService(new MemoryBucket());
		for (const address of [
			'guest+one@outside.com',
			'guest+two@outside.com',
			'guest/name%tag@outside.com',
		]) {
			await service.invite(address, actor);
			expect(await service.get(address)).toHaveProperty('email', address);
		}
		expect(await service.get(email)).toBeNull();
		await service.revoke('guest+one@outside.com');
		expect(await service.get('guest+two@outside.com')).not.toBeNull();
	});

	it('does not authorize or list a record stored under another email', async () => {
		const bucket = new MemoryBucket();
		const service = new AuthInvitationService(bucket);
		const valid = await service.invite('valid@outside.com', actor);
		await bucket.put(
			paths.authInvitation(email),
			JSON.stringify({
				email: 'other@outside.com',
				created_at: new Date().toISOString(),
				created_by: actor,
			}),
		);
		expect(await service.get(email)).toBeNull();
		expect(await service.list()).toEqual([valid]);
	});

	it('skips corrupt objects while listing valid invitations and logs each failure', async () => {
		const bucket = new MemoryBucket();
		const service = new AuthInvitationService(bucket);
		const valid = await service.invite(email, actor);
		await bucket.put(paths.authInvitation('bad-json@outside.com'), '{');
		await bucket.put(paths.authInvitation('bad-schema@outside.com'), '{}');
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			expect(await service.list()).toEqual([valid]);
			expect(log).toHaveBeenCalledTimes(2);
			expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						event: 'stored_object_skipped',
						object: paths.authInvitation('bad-json@outside.com'),
					}),
					expect.objectContaining({
						event: 'stored_object_skipped',
						object: paths.authInvitation('bad-schema@outside.com'),
					}),
				]),
			);
		} finally {
			log.mockRestore();
		}
	});

	it('does not list noncanonical emails even when they match their storage key', async () => {
		const bucket = new MemoryBucket();
		await bucket.put(
			paths.authInvitation('Guest@Outside.com'),
			JSON.stringify({
				email: 'Guest@Outside.com',
				created_at: new Date().toISOString(),
				created_by: actor,
			}),
		);
		expect(await new AuthInvitationService(bucket).list()).toEqual([]);
	});

	it('propagates storage outages instead of returning an incomplete directory', async () => {
		const bucket = new MemoryBucket();
		const service = new AuthInvitationService(bucket);
		await service.invite(email, actor);
		vi.spyOn(bucket, 'get').mockRejectedValue(new Error('storage unavailable'));
		await expect(service.list()).rejects.toThrow('storage unavailable');
	});

	it('preserves invitations after a failed delete, permits retry, and can re-invite', async () => {
		const bucket = new MemoryBucket();
		const service = new AuthInvitationService(bucket);
		await service.invite(email, actor);
		vi.spyOn(bucket, 'delete').mockRejectedValueOnce(new Error('delete unavailable'));
		await expect(service.revoke(email)).rejects.toThrow('delete unavailable');
		expect(await service.get(email)).not.toBeNull();
		await service.revoke(email);
		await service.revoke(email);
		expect(await service.get(email)).toBeNull();
		expect(await service.invite(email, UserId.parse('second-admin'))).toHaveProperty(
			'created_by',
			'second-admin',
		);
	});

	it('does not persist a failed create and can retry successfully', async () => {
		const bucket = new MemoryBucket();
		const service = new AuthInvitationService(bucket);
		vi.spyOn(bucket, 'put').mockRejectedValueOnce(new Error('write unavailable'));
		await expect(service.invite(email, actor)).rejects.toThrow('write unavailable');
		expect(await service.get(email)).toBeNull();
		expect(await service.invite(email, actor)).toHaveProperty('email', email);
	});

	it('fails after bounded write conflicts without granting access', async () => {
		const bucket = new MemoryBucket();
		const service = new AuthInvitationService(bucket);
		const put = vi.spyOn(bucket, 'put').mockRejectedValue(new PreconditionFailedError('conflict'));
		await expect(service.invite(email, actor)).rejects.toThrow('max retries exceeded');
		expect(put).toHaveBeenCalledTimes(5);
		expect(await service.get(email)).toBeNull();
	});

	it('paginates the directory and tolerates an invitation removed during the scan', async () => {
		const bucket = new MemoryBucket();
		const service = new AuthInvitationService(bucket);
		for (const address of ['c@outside.com', 'a@outside.com', 'b@outside.com'])
			await service.invite(address, actor);
		const list = bucket.list.bind(bucket);
		vi.spyOn(bucket, 'list').mockImplementation((options) => list({ ...options, limit: 1 }));
		const get = bucket.get.bind(bucket);
		vi.spyOn(bucket, 'get').mockImplementation((key) =>
			key === paths.authInvitation('b@outside.com') ? Promise.resolve(null) : get(key),
		);
		expect((await service.list()).map((record) => record.email)).toEqual([
			'a@outside.com',
			'c@outside.com',
		]);
		expect(bucket.list).toHaveBeenCalledTimes(3);
	});
});
