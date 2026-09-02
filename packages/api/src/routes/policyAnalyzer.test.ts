import { describe, expect, it } from 'vitest';
import { LocalResourceConstraintPolicy } from '@marimo-hub/core';
import type { Authenticator } from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

function authorizationCase(overrides: Record<string, unknown> = {}) {
	return {
		id: 'case-1',
		name: 'Owner can read',
		authorization: {
			subject: {
				id: ACTOR,
				email: `${ACTOR}@example.com`,
				entitlement_source: 'explicit',
				entitlements: [],
			},
			action: 'project.read',
			resource: {
				source: 'synthetic',
				kind: 'project',
				project: { owner: ACTOR, members: [], status: 'active' },
			},
			context: { mode: 'synthetic', value: null },
			expected: { allowed: true },
			...overrides,
		},
	};
}

describe('policy analyzer routes', () => {
	it('requires super-admin standing', async () => {
		const { request } = createTestApi();
		await expectError(await request('GET', '/admin/policy-analyzer/metadata'), 403, 'FORBIDDEN');
	});

	it.each([
		['GET', '/admin/policy-analyzer/metadata', undefined],
		[
			'POST',
			'/admin/policy-analyzer/evaluate',
			{ schema_version: 1, cases: [authorizationCase()] },
		],
	] as const)('rejects personal access tokens on %s %s', async (method, path, body) => {
		const authenticator: Authenticator = {
			authenticate: async () => ({
				id: ACTOR,
				email: `${ACTOR}@example.com`,
				credential: { kind: 'personal-access-token', id: 'tok-policy-analysis' },
			}),
		};
		const { request } = createTestApi({
			deps: { authenticator, policy: { superAdmins: [ACTOR] } },
		});
		const error = await expectError(await request(method, path, body), 403, 'FORBIDDEN');
		expect(error.message).toContain('Personal access tokens cannot');
	});

	it('returns the configured action and entitlement metadata', async () => {
		const { request } = createTestApi({
			deps: {
				policy: { superAdmins: [ACTOR] },
				policyAnalyzer: { classificationOrder: ['LEVEL_1', 'LEVEL_2'] },
			},
		});
		const data = await expectOk<{
			classification_order: string[];
			entitlements: string[];
			actions: { action: string }[];
		}>(await request('GET', '/admin/policy-analyzer/metadata'));
		expect(data.classification_order).toEqual(['LEVEL_1', 'LEVEL_2']);
		expect(data.entitlements).toContain('super-admin');
		expect(data.actions).toContainEqual(expect.objectContaining({ action: 'project.read' }));
	});

	it('evaluates a synthetic authorization case and returns a bounded trace', async () => {
		const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
		const data = await expectOk<any>(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [authorizationCase()],
			}),
		);
		expect(data).toMatchObject({
			valid: true,
			summary: { case_count: 1, passed: 1, failed: 0 },
			cases: [
				{
					valid: true,
					authorization: {
						decision: { allowed: true, role: 'admin' },
						assertion: { passed: true },
					},
				},
			],
		});
		expect(data.cases[0].authorization.trace).toContainEqual(
			expect.objectContaining({ stage: 'role', code: 'effective_role_static-super-admin' }),
		);
	});

	it('links normalized login entitlements into authorization', async () => {
		const { deps, request } = createTestApi({
			deps: {
				policy: { superAdmins: [ACTOR], projectCreationRestricted: true },
				policyAnalyzer: {
					classificationOrder: [],
					loginPolicy: {
						evaluate: async () => ({
							outcome: 'allow',
							entitlements: ['project-creator'],
							durationMs: 2,
						}),
					},
				},
			},
		});
		const data = await expectOk<any>(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [
					{
						id: 'linked',
						name: 'Creator entitlement',
						login: {
							identity: { id: 'new-user', email: 'new@example.com' },
							id_token_claims: { group: 'creators' },
							expected: { outcome: 'allow', entitlements: ['project-creator'] },
						},
						authorization: {
							subject: {
								id: 'new-user',
								email: 'new@example.com',
								entitlement_source: 'login',
							},
							action: 'project.create',
							resource: { source: 'synthetic', kind: 'deployment' },
							context: { mode: 'synthetic', value: null },
							expected: { allowed: true },
						},
					},
				],
			}),
		);
		expect(data.valid).toBe(true);
		expect(data.cases[0].login.entitlements).toEqual(['project-creator']);
		expect(JSON.stringify(data)).not.toContain('creators');
		const events = await deps.services.events.getEvents(new Date().toISOString().slice(0, 10));
		const analysisEvents = events.filter((event) => event.event === 'policy.analysis.run');
		expect(analysisEvents).toHaveLength(1);
		expect(analysisEvents[0]).toMatchObject({
			actor: ACTOR,
			case_count: 1,
			stages: ['login', 'authorization'],
			actions: ['project.create'],
			project_ids: [],
			valid: true,
			passed: 1,
			failed: 0,
		});
		const auditJson = JSON.stringify(analysisEvents[0]);
		expect(auditJson).not.toContain('creators');
		expect(auditJson).not.toContain('project-creator');
		expect(auditJson).not.toContain('new@example.com');
	});

	it('does not assert login entitlements when the expectation omits them', async () => {
		const { request } = createTestApi({
			deps: {
				policy: { superAdmins: [ACTOR] },
				policyAnalyzer: {
					classificationOrder: [],
					loginPolicy: {
						evaluate: async () => ({
							outcome: 'allow',
							entitlements: ['project-creator'],
							durationMs: 2,
						}),
					},
				},
			},
		});
		const data = await expectOk<any>(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [
					{
						id: 'outcome-only',
						name: 'Allow without entitlement assertion',
						login: {
							identity: { id: 'new-user', email: 'new@example.com' },
							id_token_claims: {},
							expected: { outcome: 'allow' },
						},
					},
				],
			}),
		);
		expect(data).toMatchObject({
			valid: true,
			cases: [
				{
					valid: true,
					login: {
						outcome: 'allow',
						entitlements: ['project-creator'],
						assertion: { passed: true },
					},
				},
			],
		});
	});

	it('rejects entitlement expectations for a denied login', async () => {
		const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
		await expectError(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [
					{
						id: 'invalid-denial',
						name: 'Denied login with entitlements',
						login: {
							identity: { id: 'new-user', email: 'new@example.com' },
							id_token_claims: {},
							expected: { outcome: 'deny', entitlements: [] },
						},
					},
				],
			}),
			422,
			'VALIDATION_ERROR',
		);
	});

	it('rejects a case without a login or authorization stage', async () => {
		const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
		await expectError(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [{ id: 'empty', name: 'No stages' }],
			}),
			422,
			'VALIDATION_ERROR',
		);
	});

	it('treats an expected login denial as valid and skips linked authorization', async () => {
		const { request } = createTestApi({
			deps: {
				policy: { superAdmins: [ACTOR] },
				policyAnalyzer: {
					classificationOrder: [],
					loginPolicy: {
						evaluate: async () => ({ outcome: 'deny', reason: 'not_eligible', durationMs: 2 }),
					},
				},
			},
		});
		const data = await expectOk<any>(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [
					{
						id: 'expected-denial',
						name: 'Ineligible subject',
						login: {
							identity: { id: 'new-user', email: 'new@example.com' },
							id_token_claims: {},
							expected: { outcome: 'deny' },
						},
						authorization: {
							subject: {
								id: 'new-user',
								email: 'new@example.com',
								entitlement_source: 'login',
							},
							action: 'project.create',
							resource: { source: 'synthetic', kind: 'deployment' },
							context: { mode: 'synthetic', value: null },
							expected: { allowed: false },
						},
					},
				],
			}),
		);
		expect(data).toMatchObject({
			valid: true,
			cases: [
				{
					valid: true,
					login: { outcome: 'deny', assertion: { passed: true } },
					authorization: null,
					errors: [],
				},
			],
		});
	});

	it('does not resolve live context for another identity', async () => {
		const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
		const data = await expectOk<any>(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [
					authorizationCase({
						subject: {
							id: 'other-user',
							email: 'other@example.com',
							entitlement_source: 'explicit',
						},
						context: { mode: 'live-self' },
					}),
				],
			}),
		);
		expect(data.valid).toBe(false);
		expect(data.cases[0].errors).toEqual([
			{ stage: 'authorization', code: 'live_context_requires_self' },
		]);
	});

	it('checks the actual notebook labels before analyzing a stored session', async () => {
		const bucket = await createInitializedBucket();
		const setup = createTestApi({ bucket });
		const project = await setup.deps.services.projects.createProject(
			{ name: 'Stored policy project', description: '' },
			ACTOR,
		);
		const notebook = await setup.deps.services.notebooks.createNotebook(
			project.id,
			{ title: 'Restricted', description: '', code: 'import marimo' },
			ACTOR,
		);
		await setup.deps.services.notebooks.setSecurityLabels(
			project.id,
			notebook.id,
			{ classification: 'LEVEL_2', compartments: [] },
			ACTOR,
		);
		const session = await setup.deps.services.sessions.createSession({
			project_id: project.id,
			notebook_id: notebook.id,
			user_id: ACTOR,
		});
		const { request } = createTestApi({
			bucket,
			deps: {
				policy: { superAdmins: [ACTOR] },
				resourceSecurity: {
					constraints: new LocalResourceConstraintPolicy({
						classificationOrder: ['LEVEL_1', 'LEVEL_2'],
					}),
				},
			},
		});
		const data = await expectOk<any>(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [
					authorizationCase({
						action: 'session.attach',
						resource: {
							source: 'stored',
							kind: 'session',
							project_id: project.id,
							session_id: session.session_id,
						},
					}),
				],
			}),
		);
		expect(data.valid).toBe(false);
		expect(data.cases[0].errors).toEqual([
			{ stage: 'authorization', code: 'stored_resource_inaccessible' },
		]);
	});
});
