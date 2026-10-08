import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationService, LocalResourceConstraintPolicy } from '@marimo-hub/core';
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
		expect(data.entitlements).toContain('default-role:app-user');
		expect(data.actions).toContainEqual(
			expect.objectContaining({ action: 'app.read', minimum_role: 'app-user' }),
		);
		expect(data.actions).toContainEqual(expect.objectContaining({ action: 'project.read' }));
	});

	it.each([true, false, undefined])(
		'evaluates project creation for app_only=%s',
		async (appOnly) => {
			const { request } = createTestApi({
				deps: { policy: { superAdmins: [ACTOR], defaultRole: 'manager' } },
			});
			const data = await expectOk<any>(
				await request('POST', '/admin/policy-analyzer/evaluate', {
					schema_version: 1,
					cases: [
						authorizationCase({
							subject: {
								id: 'stakeholder',
								email: 'stakeholder@example.com',
								entitlement_source: 'explicit',
								entitlements: [],
							},
							action: 'project.create',
							resource: { source: 'synthetic', kind: 'deployment', app_only: appOnly },
							expected: { allowed: appOnly === false },
						}),
					],
				}),
			);
			expect(data.valid).toBe(true);
			expect(data.cases[0].authorization.decision).toMatchObject({ allowed: appOnly === false });
		},
	);

	it('round-trips app-user membership and app-read decisions', async () => {
		const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
		const data = await expectOk<any>(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [
					authorizationCase({
						subject: {
							id: 'stakeholder',
							email: 'stakeholder@example.com',
							entitlement_source: 'explicit',
							entitlements: [],
						},
						action: 'app.read',
						resource: {
							source: 'synthetic',
							kind: 'project',
							project: { owner: ACTOR, members: [{ user_id: 'stakeholder', role: 'app-user' }] },
						},
					}),
				],
			}),
		);
		expect(data.valid).toBe(true);
		expect(data.cases[0].authorization.decision).toMatchObject({ allowed: true, role: 'app-user' });
	});

	it.each(['project', 'session', 'session-start'])(
		'rejects app_only on %s resources',
		async (kind) => {
			const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
			for (const source of ['synthetic', 'stored']) {
				for (const appOnly of [true, false]) {
					await expectError(
						await request('POST', '/admin/policy-analyzer/evaluate', {
							schema_version: 1,
							cases: [authorizationCase({ resource: { source, kind, app_only: appOnly } })],
						}),
						422,
					);
				}
			}
		},
	);

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
							groups: [],
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
							expected: { outcome: 'allow', groups: [], entitlements: ['project-creator'] },
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
							groups: [],
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
						groups: [],
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

	it('preserves caller credential context when analyzing a live scoped grant', async () => {
		const subjectContext = vi.fn(
			async (principal: { credential: { subjectContextRef?: string } }) =>
				principal.credential.subjectContextRef === 'clearance-1'
					? {
							schemaVersion: 1 as const,
							classification: 'LEVEL_1',
							compartments: [],
							policyVersion: 'policy-1',
							expiresAt: new Date(Date.now() + 60_000).toISOString(),
						}
					: null,
		);
		const authenticator: Authenticator = {
			authenticate: async () => ({
				id: ACTOR,
				email: `${ACTOR}@example.com`,
				credential: {
					kind: 'sso',
					id: 'sso-session-1',
					expiresAt: new Date(Date.now() + 120_000).toISOString(),
					subjectContextRef: 'clearance-1',
				},
			}),
		};
		const { request } = createTestApi({
			deps: {
				authenticator,
				policy: { superAdmins: [ACTOR] },
				resourceSecurity: {
					constraints: new LocalResourceConstraintPolicy({
						classificationOrder: ['LEVEL_1'],
					}),
					subjectContext: { resolve: subjectContext },
				},
			},
		});
		const grant = { actions: ['project.read'] as const, projects: '*' as const };
		const data = await expectOk<any>(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [
					authorizationCase({
						subject: {
							id: ACTOR,
							email: `${ACTOR}@example.com`,
							entitlement_source: 'explicit',
							entitlements: [],
							grant,
						},
						resource: {
							source: 'synthetic',
							kind: 'project',
							project: {
								owner: ACTOR,
								members: [],
								status: 'active',
								security_labels: { classification: 'LEVEL_1', compartments: [] },
							},
						},
						context: { mode: 'live-self' },
					}),
				],
			}),
		);

		expect(data.valid).toBe(true);
		expect(subjectContext).toHaveBeenCalledWith(
			expect.objectContaining({
				credential: expect.objectContaining({
					kind: 'personal-access-token',
					id: 'sso-session-1',
					subjectContextRef: 'clearance-1',
					grant,
				}),
			}),
			expect.any(AbortSignal),
		);
	});

	it.each([true, false, undefined])(
		'analyzes viewer attachment with credential restriction %s',
		async (restricted) => {
			const { request } = createTestApi({
				deps: { policy: { superAdmins: [ACTOR], viewerMode: 'ephemeral-sandbox' } },
			});
			const data = await expectOk<{
				cases: { authorization: { decision: { allowed: boolean } } }[];
			}>(
				await request('POST', '/admin/policy-analyzer/evaluate', {
					schema_version: 1,
					cases: [
						authorizationCase({
							subject: {
								id: 'viewer',
								email: 'viewer@example.com',
								entitlement_source: 'explicit',
								entitlements: [],
							},
							action: 'session.attach',
							resource: {
								source: 'synthetic',
								kind: 'session',
								project: {
									owner: ACTOR,
									members: [{ user_id: 'viewer', role: 'viewer' }],
									status: 'active',
								},
								session: {
									mode: 'edit',
									ephemeral: true,
									user_id: 'viewer',
									restricted_viewer_credentials: restricted,
								},
							},
							expected: { allowed: restricted === true },
						}),
					],
				}),
			);
			expect(data.cases[0].authorization.decision.allowed).toBe(restricted === true);
		},
	);

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

describe('policy analyzer membership groups', () => {
	afterEach(() => vi.restoreAllMocks());
	it.each([
		{ expected: ['team-b', 'team-a', 'team-a'], passed: true },
		{ expected: ['wrong'], passed: false },
		{ expected: Array.from({ length: 40 }, (_, i) => (i % 2 ? 'team-a' : 'team-b')), passed: true },
	])(
		'compares expected groups as sets and links them into authorization: %j',
		async ({ expected, passed }) => {
			const { request, deps } = createTestApi({
				deps: {
					policy: { superAdmins: [ACTOR] },
					policyAnalyzer: {
						classificationOrder: [],
						loginPolicy: {
							evaluate: async () => ({
								outcome: 'allow',
								entitlements: [],
								groups: ['team-a', 'team-b'],
								durationMs: 1,
							}),
						},
					},
				},
			});
			const analyze = vi.spyOn(AuthorizationService.prototype, 'analyze');
			const entry = authorizationCase();
			entry.authorization.subject.entitlement_source = 'login';
			const data = await expectOk<any>(
				await request('POST', '/admin/policy-analyzer/evaluate', {
					schema_version: 1,
					cases: [
						{
							...entry,
							login: {
								identity: { id: ACTOR, email: `${ACTOR}@example.com` },
								id_token_claims: {},
								expected: { outcome: 'allow', groups: expected },
							},
						},
					],
				}),
			);
			expect(data.cases[0].login.groups).toEqual(['team-a', 'team-b']);
			expect(data.valid).toBe(passed);
			expect(analyze).toHaveBeenCalledWith(
				expect.objectContaining({ groups: ['team-a', 'team-b'] }),
				expect.anything(),
				expect.anything(),
				expect.anything(),
			);
			const events = await deps.services.events.getEvents(new Date().toISOString().slice(0, 10));
			expect(JSON.stringify(events)).not.toContain('team-a');
		},
	);
	it.each([
		['a,b'],
		['a\n'],
		Array.from({ length: 33 }, (_, i) => `g${i}`),
		Array.from({ length: 12 }, (_, i) => `${i}${'x'.repeat(120)}`),
	])('rejects invalid explicit groups: %j', async (...groups) => {
		const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
		const entry = authorizationCase();
		await expectError(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [authorizationCase({ subject: { ...entry.authorization.subject, groups } })],
			}),
			422,
		);
	});
	it('normalizes duplicate-heavy explicit groups before enforcing count and byte limits', async () => {
		const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
		const analyze = vi.spyOn(AuthorizationService.prototype, 'analyze');
		const entry = authorizationCase();
		const group = 'x'.repeat(128);
		const data = await expectOk<any>(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [
					authorizationCase({
						subject: {
							...entry.authorization.subject,
							groups: Array.from({ length: 40 }, () => group),
						},
					}),
				],
			}),
		);
		expect(data.valid).toBe(true);
		expect(analyze).toHaveBeenCalledWith(
			expect.objectContaining({ groups: [group] }),
			expect.anything(),
			expect.anything(),
			expect.anything(),
		);
	});

	it.each([
		{ groups: Array.from({ length: 33 }, (_, i) => `g${i}`) },
		{ groups: Array.from({ length: 12 }, (_, i) => `${i}${'x'.repeat(120)}`) },
	])('explains normalized group bounds on both analyzer inputs: $groups', async ({ groups }) => {
		const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
		const entry = authorizationCase();
		for (const testCase of [
			authorizationCase({ subject: { ...entry.authorization.subject, groups } }),
			{
				id: entry.id,
				name: entry.name,
				login: {
					identity: { id: ACTOR, email: `${ACTOR}@example.com` },
					id_token_claims: {},
					expected: { outcome: 'allow', groups },
				},
			},
		]) {
			const error = await expectError(
				await request('POST', '/admin/policy-analyzer/evaluate', {
					schema_version: 1,
					cases: [testCase],
				}),
				422,
			);
			expect(error.message).toContain('at most 32 IDs and 1280 UTF-8 JSON bytes');
		}
	});

	it('reports the membership cap in metadata', async () => {
		const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
		expect(await expectOk(await request('GET', '/admin/policy-analyzer/metadata'))).toMatchObject({
			max_groups: 32,
		});
	});
});

describe('policy analyzer group isolation', () => {
	afterEach(() => vi.restoreAllMocks());

	it.each([{ groups: undefined }, { groups: ['simulated-team'] }])(
		'preserves authenticated groups instead of supplied groups in live-self analysis: %j',
		async ({ groups }) => {
			const { request } = createTestApi({
				deps: {
					policy: { superAdmins: [ACTOR] },
					authenticator: {
						authenticate: async () => ({
							id: ACTOR,
							email: `${ACTOR}@example.com`,
							credential: { kind: 'sso' },
							groups: ['ambient-team'],
						}),
					},
				},
			});
			const analyze = vi.spyOn(AuthorizationService.prototype, 'analyze');
			const original = authorizationCase();
			const data = await expectOk<any>(
				await request('POST', '/admin/policy-analyzer/evaluate', {
					schema_version: 1,
					cases: [
						authorizationCase({
							subject: { ...original.authorization.subject, groups },
							context: { mode: 'live-self' },
						}),
					],
				}),
			);
			expect(data.valid).toBe(true);
			expect(analyze).toHaveBeenCalledWith(
				expect.objectContaining({ groups: ['ambient-team'] }),
				'project.read',
				expect.anything(),
				{ mode: 'live' },
			);
		},
	);

	it.each(
		(['live-self', 'synthetic'] as const).flatMap((mode) =>
			(['explicit', 'login'] as const).flatMap((source) =>
				[false, true].map((directMember) => ({ mode, source, directMember })),
			),
		),
	)(
		'clears IdP groups for simulated PATs: $mode / $source / direct member $directMember',
		async ({ mode, source, directMember }) => {
			const { request } = createTestApi({
				deps: {
					authenticator: {
						authenticate: async () => ({
							id: ACTOR,
							email: `${ACTOR}@example.com`,
							credential: { kind: 'sso' },
							entitlements: ['super-admin'],
							groups: ['ambient-team'],
						}),
					},
					policyAnalyzer: {
						classificationOrder: [],
						loginPolicy: {
							evaluate: async () => ({
								outcome: 'allow',
								entitlements: [],
								groups: ['login-team'],
								durationMs: 0,
							}),
						},
					},
				},
			});
			const analyze = vi.spyOn(AuthorizationService.prototype, 'analyze');
			const grant = { actions: ['project.read'], projects: '*' };
			const entry = authorizationCase({
				subject: {
					id: ACTOR,
					email: `${ACTOR}@example.com`,
					entitlement_source: source,
					entitlements: [],
					groups: ['supplied-team'],
					grant,
				},
				resource: {
					source: 'synthetic',
					kind: 'project',
					project: {
						owner: 'other',
						members: [
							...['ambient-team', 'supplied-team', 'login-team'].map((group) => ({
								group,
								role: 'viewer',
							})),
							...(directMember ? [{ user_id: ACTOR, role: 'viewer' }] : []),
						],
					},
				},
				context: mode === 'live-self' ? { mode } : { mode, value: null },
				expected: { allowed: directMember },
			});
			const data = await expectOk<any>(
				await request('POST', '/admin/policy-analyzer/evaluate', {
					schema_version: 1,
					cases: [
						{
							...entry,
							...(source === 'login'
								? {
										login: {
											identity: { id: ACTOR, email: `${ACTOR}@example.com` },
											id_token_claims: {},
											expected: { outcome: 'allow', groups: ['login-team'] },
										},
									}
								: {}),
						},
					],
				}),
			);
			expect(data.valid).toBe(true);
			expect(data.cases[0].authorization.decision.allowed).toBe(directMember);
			expect(analyze).toHaveBeenCalledWith(
				expect.objectContaining({
					groups: [],
					entitlements: [],
					credential: expect.objectContaining({ kind: 'personal-access-token', grant }),
				}),
				'project.read',
				expect.anything(),
				mode === 'live-self' ? { mode: 'live' } : { mode: 'synthetic', value: null },
			);
		},
	);

	it('does not reuse groups from an allowed login when a later case fails', async () => {
		const { request } = createTestApi({
			deps: {
				policy: { superAdmins: [ACTOR] },
				policyAnalyzer: {
					classificationOrder: [],
					loginPolicy: {
						evaluate: async ({ idTokenClaims }) =>
							idTokenClaims.allow
								? { outcome: 'allow', entitlements: [], groups: ['private-team'], durationMs: 0 }
								: { outcome: 'invalid', problem: 'invalid_group', durationMs: 0 },
					},
				},
			},
		});
		const analyze = vi.spyOn(AuthorizationService.prototype, 'analyze');
		const entry = authorizationCase();
		entry.authorization.subject.entitlement_source = 'login';
		const data = await expectOk<any>(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [true, false].map((allow) => ({
					...entry,
					id: String(allow),
					login: {
						identity: { id: ACTOR, email: `${ACTOR}@example.com` },
						id_token_claims: { allow },
						expected: { outcome: 'allow' },
					},
				})),
			}),
		);
		expect(data.cases[0].login.groups).toEqual(['private-team']);
		expect(data.cases[1]).toMatchObject({
			valid: false,
			login: { groups: [], outcome: 'invalid' },
			authorization: null,
		});
		expect(analyze).toHaveBeenCalledTimes(1);
	});
});

describe('policy analyzer project group membership', () => {
	it('uses login-policy groups for linked group authorization', async () => {
		const { request } = createTestApi({
			deps: {
				policy: { superAdmins: [ACTOR] },
				policyAnalyzer: {
					classificationOrder: [],
					loginPolicy: {
						evaluate: async () => ({
							outcome: 'allow',
							entitlements: [],
							groups: ['team'],
							durationMs: 0,
						}),
					},
				},
			},
		});
		const entry = authorizationCase({
			subject: { id: 'subject', email: 'subject@example.com', entitlement_source: 'login' },
			resource: {
				source: 'synthetic',
				kind: 'project',
				project: { owner: 'other', members: [{ group: 'team', role: 'editor' }] },
			},
		});
		const data = await expectOk(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [
					{
						...entry,
						login: {
							identity: { id: 'subject', email: 'subject@example.com' },
							id_token_claims: {},
							expected: { outcome: 'allow', groups: ['team'] },
						},
					},
				],
			}),
		);
		expect(data.valid).toBe(true);
		expect(JSON.stringify(data)).toContain('effective_role_member-group');
	});
	it('resolves synthetic group memberships with the group role source', async () => {
		const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
		const data = await expectOk(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [
					authorizationCase({
						subject: {
							id: 'subject',
							email: 'subject@example.com',
							entitlement_source: 'explicit',
							groups: ['/teams/data'],
						},
						resource: {
							source: 'synthetic',
							kind: 'project',
							project: { owner: 'other', members: [{ group: '/teams/data', role: 'viewer' }] },
						},
					}),
				],
			}),
		);
		expect(data.valid).toBe(true);
		expect(JSON.stringify(data)).toContain('effective_role_member-group');
	});
	it.each([
		{ group: 'team', role: 'admin' },
		{ group: 'team', email: 'a@b.com', role: 'editor' },
		{ group: ' team', role: 'editor' },
	])('rejects invalid synthetic group rows: %j', async (member) => {
		const { request } = createTestApi({ deps: { policy: { superAdmins: [ACTOR] } } });
		await expectError(
			await request('POST', '/admin/policy-analyzer/evaluate', {
				schema_version: 1,
				cases: [
					authorizationCase({
						resource: {
							source: 'synthetic',
							kind: 'project',
							project: { owner: 'other', members: [member] },
						},
					}),
				],
			}),
			422,
		);
	});
});
