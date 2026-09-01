/**
 * Characterization of the API's authorization outcomes now that every guard
 * routes through `AuthorizationService`. Each case pins a pre-existing result —
 * an allow, a 403, a 404 mask, a session-expiry rejection, or list filtering —
 * so the centralization (and any future constraint work) cannot change them
 * silently.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { UserId } from '@marimo-hub/core';
import type { Authenticator } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing';
import { createTestApi, expectError, expectOk } from './testing';

const OWNER = UserId.parse('char-owner');
const VIEWER = UserId.parse('char-viewer');
const EDITOR = UserId.parse('char-editor');
const STRANGER = UserId.parse('char-stranger');

function apiFor(bucket: MemoryBucket, userId: UserId, deps = {}) {
	return createTestApi({ bucket, userId, deps });
}

async function seedProject(bucket: MemoryBucket) {
	const owner = apiFor(bucket, OWNER);
	const project = await expectOk<{ id: string }>(
		await owner.request('POST', '/projects', { name: 'char', description: '' }),
		201,
	);
	await expectOk(
		await owner.request('POST', `/projects/${project.id}/members`, {
			user_id: VIEWER,
			role: 'viewer',
		}),
		201,
	);
	await expectOk(
		await owner.request('POST', `/projects/${project.id}/members`, {
			user_id: EDITOR,
			role: 'editor',
		}),
		201,
	);
	return project.id;
}

describe('authorization characterization: project reads and writes', () => {
	let bucket: MemoryBucket;
	let pid: string;
	beforeEach(async () => {
		bucket = new MemoryBucket();
		pid = await seedProject(bucket);
	});

	it('masks a hidden project as 404 for a non-member, 200 for a member', async () => {
		await expectOk(await apiFor(bucket, VIEWER).request('GET', `/projects/${pid}`));
		await expectError(
			await apiFor(bucket, STRANGER).request('GET', `/projects/${pid}`),
			404,
			'NOT_FOUND',
		);
	});

	it('rejects a manager-tier write as 403 for a viewer, allows the owner', async () => {
		await expectError(
			await apiFor(bucket, VIEWER).request('PATCH', `/projects/${pid}`, { name: 'renamed' }),
			403,
			'FORBIDDEN',
		);
		await expectOk(
			await apiFor(bucket, OWNER).request('PATCH', `/projects/${pid}`, { name: 'renamed' }),
		);
	});

	it('rejects an editor-tier write as 403 for a viewer, allows an editor', async () => {
		const create = { title: 'nb', description: '', code: 'import marimo as mo' };
		await expectError(
			await apiFor(bucket, VIEWER).request('POST', `/projects/${pid}/notebooks`, create),
			403,
			'FORBIDDEN',
		);
		await expectOk(
			await apiFor(bucket, EDITOR).request('POST', `/projects/${pid}/notebooks`, create),
			201,
		);
	});

	it('answers 404 for everyone on a soft-deleted project, super admins included', async () => {
		await expectOk(await apiFor(bucket, OWNER).request('DELETE', `/projects/${pid}`));
		const god = apiFor(bucket, OWNER, { policy: { superAdmins: [OWNER] } });
		await expectError(await god.request('GET', `/projects/${pid}`), 404, 'NOT_FOUND');
		await expectError(
			await god.request('PATCH', `/projects/${pid}`, { name: 'x' }),
			404,
			'NOT_FOUND',
		);
	});

	it('grants a non-member super admin manager-tier writes', async () => {
		const god = apiFor(bucket, STRANGER, { policy: { superAdmins: [STRANGER] } });
		await expectOk(await god.request('PATCH', `/projects/${pid}`, { name: 'by-admin' }));
	});

	it('opens reads to non-members under a deployment default role', async () => {
		const guest = apiFor(bucket, STRANGER, { policy: { defaultRole: 'viewer' } });
		await expectOk(await guest.request('GET', `/projects/${pid}`));
		await expectError(
			await guest.request('PATCH', `/projects/${pid}`, { name: 'x' }),
			403,
			'FORBIDDEN',
		);
	});
});

describe('authorization characterization: deployment standing', () => {
	it('gates the admin surface on super-admin standing', async () => {
		const bucket = new MemoryBucket();
		await expectError(
			await apiFor(bucket, STRANGER).request('GET', '/admin/config'),
			403,
			'FORBIDDEN',
		);
		const god = apiFor(bucket, STRANGER, { policy: { superAdmins: [STRANGER] } });
		await expectOk(await god.request('GET', '/admin/config'));
	});

	it('gates project creation only under a restricted deployment', async () => {
		const bucket = new MemoryBucket();
		const restricted = apiFor(bucket, STRANGER, {
			policy: { projectCreationRestricted: true },
		});
		await expectError(
			await restricted.request('POST', '/projects', { name: 'nope', description: '' }),
			403,
			'FORBIDDEN',
		);
		const god = apiFor(bucket, STRANGER, {
			policy: { projectCreationRestricted: true, superAdmins: [STRANGER] },
		});
		await expectOk(await god.request('POST', '/projects', { name: 'yes', description: '' }), 201);
	});
});

describe('authorization characterization: entitlement expiry', () => {
	it('refuses to start a session on expired group authorization', async () => {
		const bucket = new MemoryBucket();
		const pid = await seedProject(bucket);
		const owner = apiFor(bucket, OWNER);
		const notebook = await expectOk<{ id: string }>(
			await owner.request('POST', `/projects/${pid}/notebooks`, {
				title: 'nb',
				description: '',
				code: 'import marimo as mo',
			}),
			201,
		);

		const expired: Authenticator = {
			authenticate: async () => ({
				id: OWNER,
				email: `${OWNER}@example.com`,
				entitlements: ['default-role:editor'],
				entitlementsExpiresAt: new Date(Date.now() - 60_000).toISOString(),
				credential: { kind: 'sso' },
			}),
		};
		const stale = createTestApi({ bucket, userId: OWNER, deps: { authenticator: expired } });
		const res = await stale.request(
			'POST',
			`/projects/${pid}/notebooks/${notebook.id}/sessions`,
			{},
		);
		const error = await expectError(res, 403, 'FORBIDDEN');
		expect(error.message).toContain('Group authorization has expired');
	});
});

describe('authorization characterization: list filtering and pagination', () => {
	it('filters hidden projects before pagination, so cursors never leak them', async () => {
		const bucket = new MemoryBucket();
		const owner = apiFor(bucket, OWNER);
		const visible: string[] = [];
		for (let i = 0; i < 5; i += 1) {
			const project = await expectOk<{ id: string }>(
				await owner.request('POST', '/projects', { name: `p${i}`, description: '' }),
				201,
			);
			if (i % 2 === 0) {
				await expectOk(
					await owner.request('POST', `/projects/${project.id}/members`, {
						user_id: VIEWER,
						role: 'viewer',
					}),
					201,
				);
				visible.push(project.id);
			}
		}

		const member = apiFor(bucket, VIEWER);
		const firstPage = await expectOk<{ items: { id: string }[]; next_cursor: string | null }>(
			await member.request('GET', '/projects?limit=2'),
		);
		expect(firstPage.items).toHaveLength(2);
		const secondPage = await expectOk<{ items: { id: string }[]; next_cursor: string | null }>(
			await member.request('GET', `/projects?limit=2&cursor=${firstPage.next_cursor}`),
		);
		const seen = [...firstPage.items, ...secondPage.items].map((p) => p.id);
		expect(new Set(seen).size).toBe(3);
		expect(seen.sort()).toEqual([...visible].sort());
		expect(secondPage.next_cursor).toBeNull();

		const strangerList = await expectOk<{ items: unknown[] }>(
			await apiFor(bucket, STRANGER).request('GET', '/projects'),
		);
		expect(strangerList.items).toEqual([]);
	});
});
