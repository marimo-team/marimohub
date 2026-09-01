/**
 * Characterization of the API's authorization outcomes now that every guard
 * routes through `AuthorizationService`. Each case pins a pre-existing result —
 * an allow, a 403, a 404 mask, a session-expiry rejection, or list filtering —
 * so the centralization (and any future constraint work) cannot change them
 * silently.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalResourceConstraintPolicy, UserId } from '@marimo-hub/core';
import type { Authenticator } from '@marimo-hub/core';
import { makeFakeCompute, MemoryBucket } from '@marimo-hub/core/testing';
import { createTestApi, expectError, expectOk } from './testing';

const OWNER = UserId.parse('char-owner');
const VIEWER = UserId.parse('char-viewer');
const EDITOR = UserId.parse('char-editor');
const STRANGER = UserId.parse('char-stranger');

function apiFor(bucket: MemoryBucket, userId: UserId, deps = {}) {
	return createTestApi({ bucket, userId, deps });
}

type TestApi = ReturnType<typeof createTestApi>;

async function createProject(api: TestApi, name = 'char'): Promise<string> {
	const project = await expectOk<{ id: string }>(
		await api.request('POST', '/projects', { name, description: '' }),
		201,
	);
	return project.id;
}

async function addMember(api: TestApi, pid: string, member: Record<string, string>) {
	await expectOk(await api.request('POST', `/projects/${pid}/members`, member), 201);
}

async function createNotebook(api: TestApi, pid: string): Promise<string> {
	const notebook = await expectOk<{ id: string }>(
		await api.request('POST', `/projects/${pid}/notebooks`, {
			title: 'nb',
			description: '',
			code: 'import marimo as mo',
		}),
		201,
	);
	return notebook.id;
}

async function seedProject(bucket: MemoryBucket) {
	const owner = apiFor(bucket, OWNER);
	const pid = await createProject(owner);
	await addMember(owner, pid, { user_id: VIEWER, role: 'viewer' });
	await addMember(owner, pid, { user_id: EDITOR, role: 'editor' });
	return pid;
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
		await createNotebook(apiFor(bucket, EDITOR), pid);
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
		const nid = await createNotebook(owner, pid);

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
		const res = await stale.request('POST', `/projects/${pid}/notebooks/${nid}/sessions`, {});
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
			const id = await createProject(owner, `p${i}`);
			if (i % 2 === 0) {
				await addMember(owner, id, { user_id: VIEWER, role: 'viewer' });
				visible.push(id);
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

describe('authorization characterization: unhappy paths', () => {
	it('reveals existence with 403 (not 404) for a non-member write on a hidden project', async () => {
		// Pins today's asymmetry: reads mask as 404, but a write guard answers 403
		// even for a caller with no role at all.
		const bucket = new MemoryBucket();
		const pid = await seedProject(bucket);
		await expectError(
			await apiFor(bucket, STRANGER).request('PATCH', `/projects/${pid}`, { name: 'x' }),
			403,
			'FORBIDDEN',
		);
	});

	it('answers 404 on session routes for a deleted project before any session rule', async () => {
		const bucket = new MemoryBucket();
		const pid = await seedProject(bucket);
		const owner = apiFor(bucket, OWNER);
		const nid = await createNotebook(owner, pid);
		await expectOk(await owner.request('DELETE', `/projects/${pid}`));

		await expectError(
			await owner.request('POST', `/projects/${pid}/notebooks/${nid}/sessions`, {}),
			404,
			'NOT_FOUND',
		);
		await expectError(
			await owner.request(
				'DELETE',
				`/projects/${pid}/notebooks/${nid}/sessions/sess-9qm4xz7rp3w8h2k9`,
			),
			404,
			'NOT_FOUND',
		);
	});

	it('refuses group-derived authorization that carries no expiry', async () => {
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

		const unbounded: Authenticator = {
			authenticate: async () => ({
				id: OWNER,
				email: `${OWNER}@example.com`,
				entitlements: ['default-role:editor'],
				credential: { kind: 'sso' },
			}),
		};
		const api = createTestApi({ bucket, userId: OWNER, deps: { authenticator: unbounded } });
		const res = await api.request('POST', `/projects/${pid}/notebooks/${notebook.id}/sessions`, {});
		const error = await expectError(res, 403, 'FORBIDDEN');
		expect(error.message).toContain('no credential expiry');
	});

	it('admits a pending email invite by login email, never by an id collision', async () => {
		const bucket = new MemoryBucket();
		const owner = apiFor(bucket, OWNER);
		const pid = await createProject(owner, 'invites');
		await addMember(owner, pid, { email: 'invitee@example.com', role: 'viewer' });

		const invitee: Authenticator = {
			authenticate: async () => ({
				id: UserId.parse('some-idp-sub'),
				email: 'Invitee@Example.COM',
				credential: { kind: 'sso' },
			}),
		};
		const inviteeApi = createTestApi({ bucket, deps: { authenticator: invitee } });
		await expectOk(await inviteeApi.request('GET', `/projects/${pid}`));

		// An id equal to the invite email must not be admitted: invite rows bind to
		// the IdP-asserted login email, not the opaque subject id.
		const collision: Authenticator = {
			authenticate: async () => ({
				id: UserId.parse('invitee@example.com'),
				email: 'attacker@example.com',
				credential: { kind: 'sso' },
			}),
		};
		const collisionApi = createTestApi({ bucket, deps: { authenticator: collision } });
		await expectError(await collisionApi.request('GET', `/projects/${pid}`), 404, 'NOT_FOUND');
	});

	it('hides pending-invite emails from members below manager', async () => {
		const bucket = new MemoryBucket();
		const pid = await seedProject(bucket);
		const owner = apiFor(bucket, OWNER);
		await addMember(owner, pid, { email: 'pending@example.com', role: 'viewer' });

		const asViewer = await expectOk<{ members: { email?: string }[] }>(
			await apiFor(bucket, VIEWER).request('GET', `/projects/${pid}`),
		);
		expect(asViewer.members.some((m) => m.email === 'pending@example.com')).toBe(false);
		const asOwner = await expectOk<{ members: { email?: string }[] }>(
			await owner.request('GET', `/projects/${pid}`),
		);
		expect(asOwner.members.some((m) => m.email === 'pending@example.com')).toBe(true);
	});
});

describe('authorization characterization: resource security labels', () => {
	const LABELS = { classification: 'SECRET', compartments: ['element-a'] };
	const context = (overrides: Record<string, unknown> = {}) => ({
		schemaVersion: 1,
		classification: 'SECRET',
		compartments: ['element-a', 'element-b'],
		policyVersion: 'policy-1',
		expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
		...overrides,
	});
	const security = (resolved: Record<string, unknown> | null) => ({
		constraints: new LocalResourceConstraintPolicy({
			classificationOrder: ['UNCLASSIFIED', 'CUI', 'SECRET', 'TOP_SECRET'],
		}),
		subjectContext: { resolve: async () => resolved as never },
	});

	async function seedLabeled(bucket: MemoryBucket, resolved: Record<string, unknown> | null) {
		const pid = await seedProject(bucket);
		const god = apiFor(bucket, OWNER, {
			policy: { superAdmins: [OWNER], resourceSecurity: security(context()) },
		});
		await expectOk(await god.request('PUT', `/projects/${pid}/security-labels`, LABELS));
		const member = apiFor(bucket, VIEWER, {
			policy: { resourceSecurity: security(resolved) },
		});
		return { pid, god, member };
	}

	it('gates label mutations on super-admin standing — the owner is refused', async () => {
		const bucket = new MemoryBucket();
		const pid = await seedProject(bucket);
		const owner = apiFor(bucket, OWNER, {
			policy: { resourceSecurity: security(context()) },
		});
		await expectError(
			await owner.request('PUT', `/projects/${pid}/security-labels`, LABELS),
			403,
			'FORBIDDEN',
		);
	});

	it('refuses labels when resource security is not configured', async () => {
		const bucket = new MemoryBucket();
		const pid = await seedProject(bucket);
		const god = apiFor(bucket, OWNER, { policy: { superAdmins: [OWNER] } });
		await expectError(
			await god.request('PUT', `/projects/${pid}/security-labels`, LABELS),
			422,
			'VALIDATION_ERROR',
		);
	});

	it('masks a labeled project as 404 without a satisfying context, 200 with one', async () => {
		const bucket = new MemoryBucket();
		const { pid, member } = await seedLabeled(bucket, null);
		await expectError(await member.request('GET', `/projects/${pid}`), 404, 'NOT_FOUND');

		const admitted = apiFor(bucket, VIEWER, {
			policy: { resourceSecurity: security(context()) },
		});
		const project = await expectOk<{ security_labels?: unknown }>(
			await admitted.request('GET', `/projects/${pid}`),
		);
		expect(project.security_labels).toEqual(LABELS);
	});

	it('hides labeled projects from lists, super admins included', async () => {
		const bucket = new MemoryBucket();
		const { pid } = await seedLabeled(bucket, null);
		const god = apiFor(bucket, OWNER, {
			policy: {
				superAdmins: [OWNER],
				resourceSecurity: security(context({ classification: 'CUI' })),
			},
		});
		const list = await expectOk<{ items: { id: string }[] }>(await god.request('GET', '/projects'));
		expect(list.items.map((p) => p.id)).not.toContain(pid);
	});

	it('bounds a session on a labeled project to the subject-context expiry', async () => {
		const bucket = new MemoryBucket();
		const ctx = context();
		const { pid } = await seedLabeled(bucket, ctx);
		const editor = createTestApi({
			bucket,
			userId: EDITOR,
			compute: makeFakeCompute(),
			deps: { policy: { resourceSecurity: security(ctx) } },
		});
		const nid = await createNotebook(editor, pid);
		const session = await expectOk<{ session_id: string }>(
			await editor.request('POST', `/projects/${pid}/notebooks/${nid}/sessions`, {}),
		);
		const record = await editor.deps.services.sessions.getSession(
			pid as never,
			session.session_id as never,
		);
		expect(record.authorization_expires_at).toBe(ctx.expiresAt);
	});

	it('enforces a notebook label override in addition to the project labels', async () => {
		const bucket = new MemoryBucket();
		const projectOnly = context({ compartments: ['element-a'] });
		const { pid } = await seedLabeled(bucket, projectOnly);
		const god = apiFor(bucket, OWNER, {
			policy: { superAdmins: [OWNER], resourceSecurity: security(context()) },
		});
		const nid = await createNotebook(god, pid);
		await expectOk(
			await god.request('PUT', `/projects/${pid}/notebooks/${nid}/security-labels`, {
				classification: 'SECRET',
				compartments: ['element-b'],
			}),
		);

		// The member's context satisfies the project labels but not the override.
		const member = apiFor(bucket, VIEWER, {
			policy: { resourceSecurity: security(projectOnly) },
		});
		await expectOk(await member.request('GET', `/projects/${pid}`));
		await expectError(
			await member.request('GET', `/projects/${pid}/notebooks/${nid}`),
			404,
			'NOT_FOUND',
		);
		const full = apiFor(bucket, VIEWER, { policy: { resourceSecurity: security(context()) } });
		await expectOk(await full.request('GET', `/projects/${pid}/notebooks/${nid}`));
	});
});

describe('authorization characterization: label mutation unhappy paths', () => {
	const LABELS = { classification: 'SECRET', compartments: ['element-a'] };
	const wired = (extra: Record<string, unknown> = {}) => ({
		policy: {
			superAdmins: [OWNER],
			resourceSecurity: {
				constraints: new LocalResourceConstraintPolicy({
					classificationOrder: ['UNCLASSIFIED', 'SECRET'],
				}),
			},
			...extra,
		},
	});

	it('answers 404 for labels on a nonexistent or deleted project', async () => {
		const bucket = new MemoryBucket();
		const god = apiFor(bucket, OWNER, wired());
		await expectError(
			await god.request('PUT', '/projects/proj-7h2k9qm4xz7rp3w8/security-labels', LABELS),
			404,
			'NOT_FOUND',
		);
		const pid = await createProject(god);
		await expectOk(await god.request('DELETE', `/projects/${pid}`));
		await expectError(
			await god.request('PUT', `/projects/${pid}/security-labels`, LABELS),
			404,
			'NOT_FOUND',
		);
	});

	it.each([
		['whitespace classification', { classification: 'TOP SECRET', compartments: [] }],
		['empty classification', { classification: '', compartments: [] }],
		[
			'too many compartments',
			{ classification: 'SECRET', compartments: Array.from({ length: 65 }, (_, i) => `c${i}`) },
		],
		['non-array compartments', { classification: 'SECRET', compartments: 'element-a' }],
	])('rejects an out-of-bounds label body: %s', async (_name, body) => {
		const bucket = new MemoryBucket();
		const god = apiFor(bucket, OWNER, wired());
		const pid = await createProject(god);
		await expectError(
			await god.request('PUT', `/projects/${pid}/security-labels`, body),
			422,
			'VALIDATION_ERROR',
		);
	});

	it('refuses label mutations from a personal access token, super admin included', async () => {
		const bucket = new MemoryBucket();
		const god = apiFor(bucket, OWNER, wired());
		const pid = await createProject(god);
		const pat: Authenticator = {
			authenticate: async () => ({
				id: OWNER,
				email: `${OWNER}@example.com`,
				credential: { kind: 'personal-access-token', id: 'tok-1' },
			}),
		};
		const viaPat = createTestApi({ bucket, deps: { authenticator: pat, ...wired() } });
		const error = await expectError(
			await viaPat.request('PUT', `/projects/${pid}/security-labels`, LABELS),
			403,
			'FORBIDDEN',
		);
		expect(error.message).toContain('Personal access tokens cannot');
	});

	it('keeps a labeled project failing closed when resource security is unwired — no clearing escape hatch', async () => {
		// Removing the classification order does NOT unlock labeled projects:
		// clearing requires passing authorization on the still-labeled project,
		// which fails closed without an evaluator. Remediation is restoring the
		// configuration, not a bypass.
		const bucket = new MemoryBucket();
		const god = apiFor(bucket, OWNER, wired());
		const pid = await createProject(god);
		await expectOk(await god.request('PUT', `/projects/${pid}/security-labels`, LABELS));
		const unwired = apiFor(bucket, OWNER, { policy: { superAdmins: [OWNER] } });
		await expectError(
			await unwired.request('DELETE', `/projects/${pid}/security-labels`),
			404,
			'NOT_FOUND',
		);
	});

	it('lets a super admin with a dominating context clear labels', async () => {
		const bucket = new MemoryBucket();
		const ctx = {
			schemaVersion: 1,
			classification: 'SECRET',
			compartments: ['element-a'],
			policyVersion: 'p1',
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		};
		const god = apiFor(
			bucket,
			OWNER,
			wired({
				resourceSecurity: {
					constraints: new LocalResourceConstraintPolicy({
						classificationOrder: ['UNCLASSIFIED', 'SECRET'],
					}),
					subjectContext: { resolve: async () => ctx as never },
				},
			}),
		);
		const pid = await createProject(god);
		await expectOk(await god.request('PUT', `/projects/${pid}/security-labels`, LABELS));
		const cleared = await expectOk<{ security_labels?: unknown }>(
			await god.request('DELETE', `/projects/${pid}/security-labels`),
		);
		expect(cleared.security_labels).toBeUndefined();
	});

	it('answers 404 for labels on a deleted notebook', async () => {
		const bucket = new MemoryBucket();
		const god = apiFor(bucket, OWNER, wired());
		const pid = await createProject(god);
		const nid = await createNotebook(god, pid);
		await expectOk(await god.request('DELETE', `/projects/${pid}/notebooks/${nid}`));
		await expectError(
			await god.request('PUT', `/projects/${pid}/notebooks/${nid}/security-labels`, LABELS),
			404,
			'NOT_FOUND',
		);
	});

	it('masks deep notebook reads behind an unsatisfied override', async () => {
		const bucket = new MemoryBucket();
		const ctx = {
			schemaVersion: 1,
			classification: 'SECRET',
			compartments: [],
			policyVersion: 'p1',
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		};
		const god = apiFor(bucket, OWNER, {
			policy: {
				superAdmins: [OWNER],
				resourceSecurity: {
					constraints: new LocalResourceConstraintPolicy({
						classificationOrder: ['UNCLASSIFIED', 'SECRET'],
					}),
					subjectContext: { resolve: async () => ctx as never },
				},
			},
		});
		const pid = await createProject(god);
		const nid = await createNotebook(god, pid);
		await expectOk(
			await god.request('PUT', `/projects/${pid}/notebooks/${nid}/security-labels`, {
				classification: 'SECRET',
				compartments: ['element-z'],
			}),
		);
		await expectError(
			await god.request('GET', `/projects/${pid}/notebooks/${nid}/content`),
			404,
			'NOT_FOUND',
		);
		await expectError(
			await god.request('GET', `/projects/${pid}/notebooks/${nid}/versions`),
			404,
			'NOT_FOUND',
		);
	});

	it('bounds the session to the entitlement expiry when it is earlier than the context', async () => {
		const bucket = new MemoryBucket();
		const contextExpiry = new Date(Date.now() + 3_600_000).toISOString();
		const entitlementExpiry = new Date(Date.now() + 600_000).toISOString();
		const ctx = {
			schemaVersion: 1,
			classification: 'SECRET',
			compartments: ['element-a'],
			policyVersion: 'p1',
			expiresAt: contextExpiry,
		};
		const security = {
			constraints: new LocalResourceConstraintPolicy({
				classificationOrder: ['UNCLASSIFIED', 'SECRET'],
			}),
			subjectContext: { resolve: async () => ctx as never },
		};
		const god = apiFor(bucket, OWNER, {
			policy: { superAdmins: [OWNER], resourceSecurity: security },
		});
		const pid = await createProject(god);
		const nid = await createNotebook(god, pid);
		await expectOk(
			await god.request('PUT', `/projects/${pid}/security-labels`, {
				classification: 'SECRET',
				compartments: ['element-a'],
			}),
		);

		const entitled: Authenticator = {
			authenticate: async () => ({
				id: OWNER,
				email: `${OWNER}@example.com`,
				entitlements: ['default-role:editor'],
				entitlementsExpiresAt: entitlementExpiry,
				credential: { kind: 'sso' },
			}),
		};
		const api = createTestApi({
			bucket,
			userId: OWNER,
			compute: makeFakeCompute(),
			deps: { authenticator: entitled, policy: { resourceSecurity: security } },
		});
		const session = await expectOk<{ session_id: string }>(
			await api.request('POST', `/projects/${pid}/notebooks/${nid}/sessions`, {}),
		);
		const record = await api.deps.services.sessions.getSession(
			pid as never,
			session.session_id as never,
		);
		expect(record.authorization_expires_at).toBe(entitlementExpiry);
	});
});
