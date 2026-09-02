/**
 * Resource-security composition: `roleAllowed AND constraintsSatisfied`.
 * Labels only remove access — super admins included — and every failure mode
 * (no wiring, no provider, no context, adapter error, timeout, invalid
 * context) collapses to a fail-closed `constraint` denial.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuthSubject } from '../../authz';
import { UserId } from '../../ids';
import type { AuthenticatedPrincipal } from '../../ports/auth';
import type { ResourceConstraintPolicy } from '../../ports/resourceConstraints';
import type {
	SubjectSecurityContext,
	SubjectSecurityContextProvider,
} from '../../ports/subjectContext';
import { makeProject } from '../../testing';
import { AuthorizationService } from './AuthorizationService';
import type { ResourceSecurityPolicy } from './AuthorizationService';
import { LocalResourceConstraintPolicy } from './LocalResourceConstraintPolicy';

const OWNER = UserId.parse('sec_owner');
const principal = (id = 'sec_owner'): AuthenticatedPrincipal => ({
	id: UserId.parse(id),
	email: `${id}@example.com`,
	credential: { kind: 'sso' },
});
const bareSubject: AuthSubject = { id: OWNER, email: 'sec_owner@example.com' };

const context = (overrides: Partial<SubjectSecurityContext> = {}): SubjectSecurityContext => ({
	schemaVersion: 1,
	classification: 'SECRET',
	compartments: ['element-a', 'element-b'],
	policyVersion: 'policy-1',
	expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
	...overrides,
});

const providerOf = (
	result: SubjectSecurityContext | null | (() => Promise<SubjectSecurityContext | null>),
): SubjectSecurityContextProvider => ({
	resolve: typeof result === 'function' ? result : async () => result,
});

const ORDER = ['UNCLASSIFIED', 'CUI', 'SECRET', 'TOP_SECRET'];
const local = () => new LocalResourceConstraintPolicy({ classificationOrder: ORDER });

const labeled = makeProject({
	owner: OWNER,
	members: [],
	security_labels: { classification: 'SECRET', compartments: ['element-a'] },
});
const unlabeled = makeProject({ owner: OWNER, members: [] });

function service(
	security?: Partial<ResourceSecurityPolicy> & { constraints?: ResourceConstraintPolicy },
) {
	return new AuthorizationService({}, security ? { constraints: local(), ...security } : undefined);
}

describe('LocalResourceConstraintPolicy', () => {
	it('rejects an invalid classification order at construction', () => {
		expect(() => new LocalResourceConstraintPolicy({ classificationOrder: [] })).toThrow();
		expect(
			() => new LocalResourceConstraintPolicy({ classificationOrder: ['SECRET', 'SECRET'] }),
		).toThrow(/repeat/);
		expect(
			() => new LocalResourceConstraintPolicy({ classificationOrder: ['TOP SECRET'] }),
		).toThrow(/bounded label tokens/);
	});

	it('satisfies unlabeled resources without any context', async () => {
		await expect(local().evaluate(null, 'project.read', { labels: null })).resolves.toEqual({
			satisfied: true,
		});
	});

	it('requires dominance and every compartment', async () => {
		const labels = { classification: 'SECRET', compartments: ['element-a', 'element-b'] };
		await expect(local().evaluate(context(), 'project.read', { labels })).resolves.toEqual({
			satisfied: true,
			evidence: {
				heldClassification: 'SECRET',
				requiredClassification: 'SECRET',
				classificationSatisfied: true,
				missingCompartments: [],
			},
		});
		await expect(
			local().evaluate(context({ classification: 'TOP_SECRET' }), 'project.read', { labels }),
		).resolves.toMatchObject({ satisfied: true });
		await expect(
			local().evaluate(context({ classification: 'CUI' }), 'project.read', { labels }),
		).resolves.toMatchObject({ satisfied: false, reason: 'constraint' });
		await expect(
			local().evaluate(context({ compartments: ['element-a'] }), 'project.read', { labels }),
		).resolves.toMatchObject({
			satisfied: false,
			reason: 'constraint',
			evidence: { missingCompartments: ['element-b'] },
		});
		await expect(local().evaluate(null, 'project.read', { labels })).resolves.toEqual({
			satisfied: false,
			reason: 'missing-context',
		});
	});

	it('fails closed on classifications outside the configured order — both sides', async () => {
		await expect(
			local().evaluate(context(), 'project.read', {
				labels: { classification: 'COSMIC', compartments: [] },
			}),
		).resolves.toMatchObject({ satisfied: false, reason: 'constraint' });
		await expect(
			local().evaluate(context({ classification: 'COSMIC' }), 'project.read', {
				labels: { classification: 'CUI', compartments: [] },
			}),
		).resolves.toMatchObject({ satisfied: false, reason: 'constraint' });
	});
});

describe('AuthorizationService: label constraints', () => {
	const read = { kind: 'project', project: labeled } as const;

	it('leaves unlabeled projects untouched with no wiring at all', async () => {
		await expect(
			new AuthorizationService({}).authorize(principal(), 'project.read', {
				kind: 'project',
				project: unlabeled,
			}),
		).resolves.toEqual({ allowed: true, role: 'admin' });
	});

	it('fails closed on a labeled project when no resource security is wired', async () => {
		await expect(
			new AuthorizationService({}).authorize(principal(), 'project.read', read),
		).resolves.toEqual({
			allowed: false,
			category: 'constraint',
			role: 'admin',
			constraintReason: 'unavailable',
		});
	});

	it('denies labels for super admins too — no automatic bypass', async () => {
		const god = new AuthorizationService({ superAdmins: [OWNER] }, { constraints: local() });
		await expect(god.authorize(principal(), 'project.read', read)).resolves.toEqual({
			allowed: false,
			category: 'constraint',
			role: 'admin',
			constraintReason: 'missing-context',
		});
	});

	it('grants labeled access with a dominating context and carries its expiry', async () => {
		const ctx = context();
		const decision = await service({ subjectContext: providerOf(ctx) }).authorize(
			principal(),
			'project.read',
			read,
		);
		expect(decision).toEqual({
			allowed: true,
			role: 'admin',
			subjectContextExpiresAt: ctx.expiresAt,
		});
	});

	it('never consults constraints when the role already denies', async () => {
		const resolve = vi.fn(async () => context());
		const stranger: AuthenticatedPrincipal = principal('sec_stranger');
		const decision = await service({ subjectContext: { resolve } }).authorize(
			stranger,
			'project.read',
			read,
		);
		expect(decision).toEqual({ allowed: false, category: 'visibility', role: null });
		expect(resolve).not.toHaveBeenCalled();
	});

	it.each([
		['provider returns null', providerOf(null)],
		[
			'provider throws',
			providerOf(async () => {
				throw new Error('idp down');
			}),
		],
		['provider returns an invalid context', providerOf({ classification: 'SECRET' } as never)],
		[
			'provider returns an expired context',
			providerOf(context({ expiresAt: new Date(Date.now() - 1000).toISOString() })),
		],
	] as const)('fails closed when the %s', async (_name, subjectContext) => {
		await expect(
			service({ subjectContext }).authorize(principal(), 'project.read', read),
		).resolves.toEqual({
			allowed: false,
			category: 'constraint',
			role: 'admin',
			constraintReason: 'missing-context',
		});
	});

	it('fails closed on adapter errors and timeouts', async () => {
		const throwing: ResourceConstraintPolicy = {
			evaluate: async () => {
				throw new Error('pdp down');
			},
			evaluateMany: async () => {
				throw new Error('pdp down');
			},
		};
		await expect(
			service({ constraints: throwing, subjectContext: providerOf(context()) }).authorize(
				principal(),
				'project.read',
				read,
			),
		).resolves.toEqual({
			allowed: false,
			category: 'constraint',
			role: 'admin',
			constraintReason: 'unavailable',
		});

		const hanging: ResourceConstraintPolicy = {
			evaluate: () => new Promise(() => {}),
			evaluateMany: () => new Promise(() => {}),
		};
		await expect(
			service({
				constraints: hanging,
				subjectContext: providerOf(context()),
				timeoutMs: 20,
			}).authorize(principal(), 'project.read', read),
		).resolves.toEqual({
			allowed: false,
			category: 'constraint',
			role: 'admin',
			constraintReason: 'unavailable',
		});
	});

	it('denies a bare subject without credential provenance on labeled resources', async () => {
		await expect(
			service({ subjectContext: providerOf(context()) }).authorize(
				bareSubject,
				'project.read',
				read,
			),
		).resolves.toEqual({
			allowed: false,
			category: 'constraint',
			role: 'admin',
			constraintReason: 'missing-context',
		});
	});

	it('resolves the subject context once per batch', async () => {
		const resolve = vi.fn(async () => context());
		const authz = service({ subjectContext: { resolve } });
		const decisions = await authz.authorizeMany(principal(), 'project.read', [
			read,
			{ kind: 'project', project: labeled },
			{ kind: 'project', project: unlabeled },
		]);
		expect(decisions.map((d) => d.allowed)).toEqual([true, true, true]);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('constrains session and session-start resources on labeled projects too', async () => {
		const denied = service({ subjectContext: providerOf(null) });
		await expect(
			denied.authorize(principal(), 'session.start', {
				kind: 'session-start',
				project: labeled,
				mode: 'edit',
			}),
		).resolves.toMatchObject({ allowed: false, category: 'constraint' });
		await expect(
			denied.authorize(principal(), 'session.attach', {
				kind: 'session',
				project: labeled,
				session: { mode: 'edit', user_id: OWNER },
			}),
		).resolves.toMatchObject({ allowed: false, category: 'constraint' });
	});

	it('evaluates a notebook override in addition to the project labels', async () => {
		const ctx = context({ compartments: ['element-a'] });
		const authz = service({ subjectContext: providerOf(ctx) });
		// Satisfies the project labels alone…
		await expect(authz.authorize(principal(), 'project.read', read)).resolves.toMatchObject({
			allowed: true,
		});
		// …but the notebook override adds a compartment the subject lacks.
		await expect(
			authz.authorize(principal(), 'project.read', {
				...read,
				notebookLabels: { classification: 'SECRET', compartments: ['element-b'] },
			}),
		).resolves.toEqual({
			allowed: false,
			category: 'constraint',
			role: 'admin',
			constraintReason: 'constraint',
		});
		// An override on an UNLABELED project still constrains on its own.
		await expect(
			authz.authorize(principal(), 'project.read', {
				kind: 'project',
				project: unlabeled,
				notebookLabels: { classification: 'TOP_SECRET', compartments: [] },
			}),
		).resolves.toEqual({
			allowed: false,
			category: 'constraint',
			role: 'admin',
			constraintReason: 'constraint',
		});
	});

	it('batch label decisions fail closed per entry on adapter miscounts', async () => {
		const miscounting: ResourceConstraintPolicy = {
			evaluate: async () => ({ satisfied: true }),
			evaluateMany: async () => [{ satisfied: true }],
		};
		const authz = service({ constraints: miscounting, subjectContext: providerOf(context()) });
		await expect(
			authz.projectLabelConstraints(principal(), [
				null,
				{ classification: 'SECRET', compartments: [] },
			]),
		).resolves.toEqual([true, false]);
	});

	it('emits bounded, content-free operational events on the fail-closed paths', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await new AuthorizationService({}).authorize(principal(), 'project.read', read);
			await service({
				subjectContext: providerOf(async () => {
					throw new Error('idp down');
				}),
			}).authorize(principal(), 'project.read', read);
			await service({
				subjectContext: providerOf({ classification: 'SECRET' } as never),
			}).authorize(principal(), 'project.read', read);
			const hanging: ResourceConstraintPolicy = {
				evaluate: () => new Promise(() => {}),
				evaluateMany: () => new Promise(() => {}),
			};
			await service({
				constraints: hanging,
				subjectContext: providerOf(context()),
				timeoutMs: 20,
			}).authorize(principal(), 'project.read', read);

			const events = warn.mock.calls.map(
				(call) => (JSON.parse(String(call[0])) as { event?: string }).event,
			);
			expect(events).toContain('authz_constraint_unwired');
			expect(events).toContain('authz_subject_context_failed');
			expect(events).toContain('authz_subject_context_invalid');
			expect(events).toContain('authz_constraint_timeout');
			// Content-free: no label, claim, or error text ever reaches a line.
			for (const call of warn.mock.calls) {
				expect(String(call[0])).not.toMatch(/SECRET|element-|idp down/);
			}
		} finally {
			warn.mockRestore();
		}
	});

	it('constraintsSatisfied mirrors single decisions for the list fallback', async () => {
		const authz = service({ subjectContext: providerOf(context()) });
		await expect(authz.constraintsSatisfied(principal(), null)).resolves.toBe(true);
		await expect(
			authz.constraintsSatisfied(principal(), {
				classification: 'SECRET',
				compartments: ['element-a'],
			}),
		).resolves.toBe(true);
		await expect(
			authz.constraintsSatisfied(principal(), {
				classification: 'TOP_SECRET',
				compartments: [],
			}),
		).resolves.toBe(false);
	});
});

describe('AuthorizationService: adapter trust boundary', () => {
	const read = { kind: 'project', project: labeled } as const;

	it('batches authorizeMany label sets into one adapter round-trip', async () => {
		const evaluate = vi.fn(async () => ({ satisfied: true as const }));
		const evaluateMany = vi.fn(async (_ctx, _action, resources: readonly unknown[]) =>
			resources.map(() => ({ satisfied: true as const })),
		);
		const authz = service({
			constraints: { evaluate, evaluateMany },
			subjectContext: providerOf(context()),
		});
		const decisions = await authz.authorizeMany(principal(), 'project.read', [
			read,
			{ kind: 'project', project: unlabeled },
			{
				kind: 'project',
				project: labeled,
				notebookLabels: { classification: 'SECRET', compartments: ['element-a'] },
			},
			{ kind: 'project', project: labeled },
		]);
		expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, true]);
		expect(evaluate).not.toHaveBeenCalled();
		// One call for four resources (1 + 0 + 2 + 1 label sets), input order kept.
		expect(evaluateMany).toHaveBeenCalledTimes(1);
		expect(evaluateMany.mock.calls[0][2]).toHaveLength(4);
	});

	it.each([
		['a truthy non-boolean satisfied', { satisfied: 1 }],
		['an unknown denial reason', { satisfied: false, reason: 'because' }],
		['a non-object decision', true],
	])('denies when the adapter returns %s', async (_name, malformed) => {
		const authz = service({
			constraints: {
				evaluate: async () => malformed as never,
				evaluateMany: async (_ctx, _action, resources) => resources.map(() => malformed as never),
			},
			subjectContext: providerOf(context()),
		});
		await expect(authz.authorize(principal(), 'project.read', read)).resolves.toEqual({
			allowed: false,
			category: 'constraint',
			role: 'admin',
			constraintReason: 'unavailable',
		});
		await expect(
			authz.projectLabelConstraints(principal(), [
				null,
				{ classification: 'SECRET', compartments: [] },
			]),
		).resolves.toEqual([true, false]);
	});

	it('never delegates a labeled resource to the adapter without a context', async () => {
		// A hostile or buggy adapter that satisfies everything must still be
		// unable to open a labeled resource for a context-less subject.
		const evaluate = vi.fn(async () => ({ satisfied: true as const }));
		const evaluateMany = vi.fn(async (_ctx, _action, resources: readonly unknown[]) =>
			resources.map(() => ({ satisfied: true as const })),
		);
		const authz = service({ constraints: { evaluate, evaluateMany } });
		await expect(authz.authorize(principal(), 'project.read', read)).resolves.toEqual({
			allowed: false,
			category: 'constraint',
			role: 'admin',
			constraintReason: 'missing-context',
		});
		await expect(
			authz.projectLabelConstraints(principal(), [
				null,
				{ classification: 'SECRET', compartments: [] },
			]),
		).resolves.toEqual([true, false]);
		expect(evaluate).not.toHaveBeenCalled();
		expect(evaluateMany).not.toHaveBeenCalled();
	});
});
