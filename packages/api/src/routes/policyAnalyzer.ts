import { createRoute, z } from '@hono/zod-openapi';
import {
	ACTION_RULES,
	AUTH_ENTITLEMENTS,
	AUTHORIZATION_ACTIONS,
	createProjectId,
	NotebookId,
	ProjectId,
	ProjectSchema,
	NotFoundError,
	SECURITY_LABEL_TOKEN,
	SessionId,
	SESSION_MODES,
	SubjectSecurityContextSchema,
	UserId,
	validateSubjectSecurityContext,
} from '@marimo-hub/core';
import type {
	AuthEntitlement,
	AuthorizationService,
	AuthorizationDecision,
	AuthorizationResource,
	AuthorizationSubject,
	Project,
} from '@marimo-hub/core';
import {
	assertSessionAuthenticated,
	assertSuperAdmin,
	authorizationService,
	commonErrors,
	createApp,
	errorResponses,
	jsonContent,
	loadAuthorizedNotebook,
	loadVisibleProject,
	SESSION_ONLY_SECURITY,
} from '../shared';
import type { ApiDeps, HonoEnv, LoginPolicyAnalysisResult } from '../context';
import { appendAudit } from '../log';

const MAX_POLICY_CASES = 25;

const EntitlementSchema = z.enum(AUTH_ENTITLEMENTS);
const AuthorizationActionSchema = z.enum(AUTHORIZATION_ACTIONS);
const SecurityLabelsSchema = z.strictObject({
	classification: z.string().regex(SECURITY_LABEL_TOKEN),
	compartments: z.array(z.string().regex(SECURITY_LABEL_TOKEN)).max(64),
});

const ExpectedLoginSchema = z
	.discriminatedUnion('outcome', [
		z.strictObject({
			outcome: z.literal('allow'),
			entitlements: z.array(EntitlementSchema).optional(),
		}),
		z.strictObject({ outcome: z.literal('deny') }),
	])
	.openapi('PolicyLoginExpectationV1');

const LoginStageSchema = z
	.strictObject({
		identity: z.strictObject({ id: z.string().min(1), email: z.string().min(3).max(320) }),
		id_token_claims: z.record(z.string(), z.unknown()),
		user_info_claims: z.record(z.string(), z.unknown()).optional(),
		expected: ExpectedLoginSchema,
	})
	.openapi('PolicyLoginStageV1');

const SyntheticMemberSchema = z
	.strictObject({
		user_id: z.string().min(1).optional(),
		email: z.string().min(3).max(320).optional(),
		role: z.enum(['viewer', 'editor', 'manager', 'admin']),
	})
	.refine((member) => (member.user_id === undefined) !== (member.email === undefined), {
		message: 'A member must contain one user_id or one email.',
	});

const SyntheticProjectSchema = z.strictObject({
	owner: z.string().min(1),
	members: z.array(SyntheticMemberSchema).max(500),
	status: z.enum(['active', 'deleted']).default('active'),
	security_labels: SecurityLabelsSchema.optional(),
});

const AnalysisResourceSchema = z
	.strictObject({
		source: z.enum(['stored', 'synthetic']),
		kind: z.enum(['deployment', 'project', 'session', 'session-start']),
		project_id: z.string().optional(),
		notebook_id: z.string().optional(),
		session_id: z.string().optional(),
		project: SyntheticProjectSchema.optional(),
		notebook_labels: SecurityLabelsSchema.optional(),
		session: z
			.strictObject({
				mode: z.enum(SESSION_MODES).optional(),
				ephemeral: z.boolean().optional(),
				user_id: z.string().min(1),
				editor_sandbox_sharing: z.enum(['shared', 'exclusive']).optional(),
			})
			.optional(),
		mode: z.enum(SESSION_MODES).optional(),
	})
	.openapi('PolicyAuthorizationResourceV1');

const AnalysisContextSchema = z
	.discriminatedUnion('mode', [
		z.strictObject({ mode: z.literal('live-self') }),
		z.strictObject({
			mode: z.literal('synthetic'),
			value: SubjectSecurityContextSchema.nullable(),
		}),
	])
	.openapi('PolicyAuthorizationContextV1');

const AuthorizationStageSchema = z
	.strictObject({
		subject: z.strictObject({
			id: z.string().min(1),
			email: z.string().min(3).max(320),
			entitlement_source: z.enum(['explicit', 'login']),
			entitlements: z.array(EntitlementSchema).optional(),
		}),
		action: AuthorizationActionSchema,
		resource: AnalysisResourceSchema,
		context: AnalysisContextSchema,
		expected: z.strictObject({
			allowed: z.boolean(),
			denial_category: z
				.enum(['lifecycle', 'visibility', 'role', 'session', 'standing', 'constraint'])
				.optional(),
		}),
	})
	.openapi('PolicyAuthorizationStageV1');

const PolicyCaseBaseShape = {
	id: z.string().min(1).max(128),
	name: z.string().min(1).max(200),
};

export const PolicyCaseSchema = z
	.union([
		z.strictObject({
			...PolicyCaseBaseShape,
			login: LoginStageSchema,
			authorization: AuthorizationStageSchema.optional(),
		}),
		z.strictObject({
			...PolicyCaseBaseShape,
			login: LoginStageSchema.optional(),
			authorization: AuthorizationStageSchema,
		}),
	])
	.openapi('PolicyCaseV1');

export const PolicySuiteV1Schema = z
	.strictObject({
		schema_version: z.literal(1),
		name: z.string().min(1).max(200).optional(),
		cases: z.array(PolicyCaseSchema).min(1).max(MAX_POLICY_CASES),
	})
	.openapi('PolicySuiteV1');

const AssertionSchema = z
	.strictObject({
		passed: z.boolean(),
		expected: z.record(z.string(), z.unknown()),
	})
	.openapi('PolicyAssertionResult');

const LoginResultSchema = z
	.strictObject({
		outcome: z.enum(['allow', 'deny', 'timeout', 'error', 'invalid', 'unavailable']),
		duration_ms: z.number().nonnegative(),
		entitlements: z.array(EntitlementSchema),
		reason: z.string().optional(),
		problem: z.string().optional(),
		assertion: AssertionSchema,
	})
	.openapi('PolicyLoginResult');

const AuthorizationDecisionSchema = z
	.strictObject({
		allowed: z.boolean(),
		role: z.enum(['viewer', 'editor', 'manager', 'admin']).nullable(),
		category: z
			.enum(['lifecycle', 'visibility', 'role', 'session', 'standing', 'constraint'])
			.optional(),
		constraint_reason: z.enum(['missing-context', 'constraint', 'unavailable']).optional(),
	})
	.openapi('PolicyAuthorizationDecision');

const AuthorizationTraceStepSchema = z
	.strictObject({
		stage: z.enum(['action', 'lifecycle', 'role', 'standing', 'session', 'constraint', 'final']),
		status: z.enum(['passed', 'failed', 'skipped']),
		code: z.string(),
		details: z.record(z.string(), z.unknown()).optional(),
	})
	.openapi('PolicyAuthorizationTraceStep');

const AuthorizationResultSchema = z
	.strictObject({
		decision: AuthorizationDecisionSchema,
		presentation: z.enum(['allowed', 'forbidden', 'not-found']),
		trace: z.array(AuthorizationTraceStepSchema),
		assertion: AssertionSchema,
	})
	.openapi('PolicyAuthorizationResult');

const PolicyCaseResultSchema = z
	.strictObject({
		id: z.string(),
		name: z.string(),
		valid: z.boolean(),
		login: LoginResultSchema.nullable(),
		authorization: AuthorizationResultSchema.nullable(),
		errors: z.array(
			z.strictObject({ stage: z.enum(['login', 'authorization']), code: z.string() }),
		),
	})
	.openapi('PolicyCaseResult');

const PolicySuiteSummarySchema = z
	.strictObject({
		case_count: z.number().int().nonnegative(),
		passed: z.number().int().nonnegative(),
		failed: z.number().int().nonnegative(),
	})
	.openapi('PolicySuiteSummary');

const PolicySuiteResultSchema = z
	.strictObject({
		valid: z.boolean(),
		summary: PolicySuiteSummarySchema,
		cases: z.array(PolicyCaseResultSchema),
	})
	.openapi('PolicySuiteResult');

const PolicyAnalyzerMetadataSchema = z
	.strictObject({
		schema_version: z.literal(1),
		max_cases: z.number().int().positive(),
		capabilities: z.strictObject({
			login_policy: z.boolean(),
			resource_security: z.boolean(),
			live_self_context: z.boolean(),
		}),
		entitlements: z.array(EntitlementSchema),
		classification_order: z.array(z.string()),
		actions: z.array(
			z.strictObject({
				action: AuthorizationActionSchema,
				scope: z.enum(['deployment', 'project', 'session', 'session-start']),
				minimum_role: z.enum(['viewer', 'editor', 'manager', 'admin']).nullable(),
				denied_as: z.enum(['not-found', 'forbidden']).nullable(),
				requires_super_admin: z.boolean(),
			}),
		),
	})
	.openapi('PolicyAnalyzerMetadata');

const getMetadata = createRoute({
	method: 'get',
	path: '/admin/policy-analyzer/metadata',
	operationId: 'admin.policyAnalyzer.metadata',
	tags: ['Admin'],
	summary: 'Describe policy analyzer inputs',
	security: SESSION_ONLY_SECURITY,
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: PolicyAnalyzerMetadataSchema }),
			'Policy analyzer metadata',
		),
		...commonErrors(),
		...errorResponses(403),
	},
});

const evaluateSuite = createRoute({
	method: 'post',
	path: '/admin/policy-analyzer/evaluate',
	operationId: 'admin.policyAnalyzer.evaluate',
	'x-cli-hidden': true,
	tags: ['Admin'],
	summary: 'Evaluate a policy test suite',
	security: SESSION_ONLY_SECURITY,
	request: {
		body: { content: { 'application/json': { schema: PolicySuiteV1Schema } }, required: true },
	},
	responses: {
		200: jsonContent(
			z.object({ success: z.literal(true), data: PolicySuiteResultSchema }),
			'Policy analysis results',
		),
		...commonErrors(),
		...errorResponses(403, 422),
	},
});

type PolicyCase = z.infer<typeof PolicyCaseSchema>;
type LoginStage = NonNullable<PolicyCase['login']>;
type AuthorizationStage = NonNullable<PolicyCase['authorization']>;
type PolicyCaseResult = z.infer<typeof PolicyCaseResultSchema>;

function normalizedEntitlements(values: readonly AuthEntitlement[]): AuthEntitlement[] {
	const held = new Set(values);
	return AUTH_ENTITLEMENTS.filter((entitlement) => held.has(entitlement));
}

function loginAssertion(stage: LoginStage, result: LoginPolicyAnalysisResult | undefined): boolean {
	if (!result || (result.outcome !== 'allow' && result.outcome !== 'deny')) return false;
	if (result.outcome !== stage.expected.outcome) return false;
	if (stage.expected.outcome === 'deny') return true;
	if (result.outcome !== 'allow') return false;
	if (stage.expected.entitlements === undefined) return true;
	return (
		JSON.stringify(normalizedEntitlements(result.entitlements)) ===
		JSON.stringify(normalizedEntitlements(stage.expected.entitlements))
	);
}

function loginResponse(stage: LoginStage, result?: LoginPolicyAnalysisResult) {
	const passed = loginAssertion(stage, result);
	if (!result) {
		return {
			outcome: 'unavailable' as const,
			duration_ms: 0,
			entitlements: [] as AuthEntitlement[],
			assertion: { passed, expected: stage.expected },
		};
	}
	return {
		outcome: result.outcome,
		duration_ms: result.durationMs,
		entitlements: result.outcome === 'allow' ? [...result.entitlements] : [],
		...('reason' in result && result.reason ? { reason: result.reason } : {}),
		...('problem' in result ? { problem: result.problem } : {}),
		assertion: { passed, expected: stage.expected },
	};
}

function syntheticProject(input: z.infer<typeof SyntheticProjectSchema>): Project {
	const now = new Date().toISOString();
	return ProjectSchema.parse({
		schema_version: 1,
		id: createProjectId(),
		name: 'Synthetic policy project',
		description: '',
		owner: input.owner,
		members: input.members,
		status: input.status,
		created_at: now,
		updated_at: now,
		tags: [],
		...(input.security_labels ? { security_labels: input.security_labels } : {}),
	});
}

async function storedResource(
	deps: ApiDeps,
	caller: HonoEnv['Variables']['user'],
	stage: AuthorizationStage,
): Promise<AuthorizationResource> {
	const input = stage.resource;
	if (!input.project_id) throw new Error('stored_project_required');
	const project = await loadVisibleProject(
		deps.services.projects,
		ProjectId.parse(input.project_id),
		caller,
		deps,
	);
	if (input.kind === 'session') {
		if (!input.session_id) throw new Error('stored_session_required');
		const session = await deps.services.sessions.getSession(
			project.id,
			SessionId.parse(input.session_id),
		);
		if (input.notebook_id && NotebookId.parse(input.notebook_id) !== session.notebook_id) {
			throw new Error('stored_notebook_session_mismatch');
		}
		const notebook = await loadAuthorizedNotebook(deps, project, session.notebook_id, caller);
		return {
			kind: 'session',
			project,
			session,
			notebookLabels: notebook.meta.security_labels,
		};
	}
	let notebookLabels = input.notebook_labels;
	if (input.notebook_id) {
		const notebook = await loadAuthorizedNotebook(
			deps,
			project,
			NotebookId.parse(input.notebook_id),
			caller,
		);
		notebookLabels = notebook.meta.security_labels;
	}
	if (input.kind === 'project') return { kind: 'project', project, notebookLabels };
	if (input.kind === 'session-start') {
		if (!input.mode) throw new Error('session_mode_required');
		return { kind: 'session-start', project, mode: input.mode, notebookLabels };
	}
	throw new Error('deployment_resource_must_not_be_stored');
}

function syntheticResource(stage: AuthorizationStage): AuthorizationResource {
	const input = stage.resource;
	if (input.kind === 'deployment') return { kind: 'deployment' };
	if (!input.project) throw new Error('synthetic_project_required');
	const project = syntheticProject(input.project);
	if (input.kind === 'project') {
		return { kind: 'project', project, notebookLabels: input.notebook_labels };
	}
	if (input.kind === 'session-start') {
		if (!input.mode) throw new Error('session_mode_required');
		return {
			kind: 'session-start',
			project,
			mode: input.mode,
			notebookLabels: input.notebook_labels,
		};
	}
	if (!input.session) throw new Error('synthetic_session_required');
	return {
		kind: 'session',
		project,
		session: { ...input.session, user_id: UserId.parse(input.session.user_id) },
		notebookLabels: input.notebook_labels,
	};
}

function decisionResponse(decision: AuthorizationDecision) {
	return decision.allowed
		? { allowed: true, role: decision.role }
		: {
				allowed: false,
				role: decision.role,
				category: decision.category,
				...(decision.constraintReason ? { constraint_reason: decision.constraintReason } : {}),
			};
}

async function evaluateCase(
	deps: ApiDeps,
	caller: HonoEnv['Variables']['user'],
	entry: PolicyCase,
): Promise<PolicyCaseResult> {
	const errors: PolicyCaseResult['errors'] = [];
	let loginEvaluation: LoginPolicyAnalysisResult | undefined;
	let login = null;
	if (entry.login) {
		if (!deps.policyAnalyzer?.loginPolicy) {
			errors.push({ stage: 'login', code: 'login_policy_unavailable' });
		} else {
			try {
				loginEvaluation = await deps.policyAnalyzer.loginPolicy.evaluate({
					identity: {
						id: UserId.parse(entry.login.identity.id),
						email: entry.login.identity.email,
					},
					idTokenClaims: entry.login.id_token_claims,
					...(entry.login.user_info_claims ? { userInfoClaims: entry.login.user_info_claims } : {}),
				});
			} catch {
				loginEvaluation = { outcome: 'error', durationMs: 0 };
			}
			if (loginEvaluation.outcome === 'timeout' || loginEvaluation.outcome === 'error') {
				errors.push({ stage: 'login', code: `login_policy_${loginEvaluation.outcome}` });
			}
			if (loginEvaluation.outcome === 'invalid') {
				errors.push({ stage: 'login', code: 'login_policy_invalid_result' });
			}
		}
		login = loginResponse(entry.login, loginEvaluation);
	}

	let authorization = null;
	if (entry.authorization) {
		const stage = entry.authorization;
		const linked = stage.subject.entitlement_source === 'login';
		if (linked && !entry.login) {
			errors.push({ stage: 'authorization', code: 'linked_login_stage_required' });
		} else if (linked && loginEvaluation?.outcome !== 'allow') {
			authorization = null;
		} else {
			try {
				const entitlements = normalizedEntitlements(
					linked && loginEvaluation?.outcome === 'allow'
						? loginEvaluation.entitlements
						: (stage.subject.entitlements ?? []),
				);
				let subject: AuthorizationSubject = {
					id: UserId.parse(stage.subject.id),
					email: stage.subject.email,
					entitlements,
				};
				let context: Parameters<AuthorizationService['analyze']>[3];
				if (stage.context.mode === 'live-self') {
					if (subject.id !== caller.id || subject.email !== caller.email) {
						throw new Error('live_context_requires_self');
					}
					subject = { ...caller, entitlements };
					context = { mode: 'live' };
				} else {
					const supplied = stage.context.value;
					const validated = supplied === null ? null : validateSubjectSecurityContext(supplied);
					if (supplied !== null && validated === null) throw new Error('synthetic_context_invalid');
					context = { mode: 'synthetic', value: validated };
				}
				const resource =
					stage.resource.source === 'stored'
						? await storedResource(deps, caller, stage)
						: syntheticResource(stage);
				const analysis = await authorizationService(deps).analyze(
					subject,
					stage.action,
					resource,
					context,
				);
				const categoryMatches =
					stage.expected.denial_category === undefined ||
					(!analysis.decision.allowed &&
						analysis.decision.category === stage.expected.denial_category);
				const passed = analysis.decision.allowed === stage.expected.allowed && categoryMatches;
				authorization = {
					decision: decisionResponse(analysis.decision),
					presentation: analysis.presentation,
					trace: [...analysis.trace],
					assertion: { passed, expected: stage.expected },
				};
			} catch (error) {
				errors.push({
					stage: 'authorization',
					code:
						error instanceof NotFoundError
							? 'stored_resource_inaccessible'
							: error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message)
								? error.message
								: 'authorization_analysis_failed',
				});
			}
		}
	}

	const valid =
		errors.length === 0 &&
		(login === null || login.assertion.passed) &&
		(authorization === null || authorization.assertion.passed);
	return { id: entry.id, name: entry.name, valid, login, authorization, errors };
}

const app = createApp();

app.openapi(getMetadata, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	assertSessionAuthenticated(c, 'use the policy analyzer');
	await assertSuperAdmin(user, deps);
	return c.json(
		{
			success: true,
			data: {
				schema_version: 1 as const,
				max_cases: MAX_POLICY_CASES,
				capabilities: {
					login_policy: deps.policyAnalyzer?.loginPolicy !== undefined,
					resource_security: deps.resourceSecurity !== undefined,
					live_self_context: deps.resourceSecurity?.subjectContext !== undefined,
				},
				entitlements: [...AUTH_ENTITLEMENTS],
				classification_order: [...(deps.policyAnalyzer?.classificationOrder ?? [])],
				actions: AUTHORIZATION_ACTIONS.map((action) => {
					const rule = ACTION_RULES[action];
					return {
						action,
						scope: rule.scope,
						minimum_role: 'min' in rule ? rule.min : null,
						denied_as: 'deniedAs' in rule ? rule.deniedAs : null,
						requires_super_admin: 'requiresSuperAdmin' in rule && rule.requiresSuperAdmin === true,
					};
				}),
			},
		},
		200,
	);
});

app.openapi(evaluateSuite, async (c) => {
	const deps = c.get('deps');
	const user = c.get('user');
	assertSessionAuthenticated(c, 'use the policy analyzer');
	await assertSuperAdmin(user, deps);
	const suite = c.req.valid('json');
	const cases: PolicyCaseResult[] = [];
	for (const entry of suite.cases) cases.push(await evaluateCase(deps, user, entry));
	const passed = cases.filter((entry) => entry.valid).length;
	const result = {
		valid: passed === cases.length,
		summary: { case_count: cases.length, passed, failed: cases.length - passed },
		cases,
	};
	await appendAudit(
		{ requestId: c.get('requestId'), method: c.req.method, path: c.req.path, userId: user.id },
		'policy.analysis.run',
		() =>
			deps.services.events.append({
				event: 'policy.analysis.run',
				actor: user.id,
				case_count: cases.length,
				stages: suite.cases.flatMap((entry) => [
					...(entry.login ? ['login'] : []),
					...(entry.authorization ? ['authorization'] : []),
				]),
				actions: suite.cases.flatMap((entry) =>
					entry.authorization ? [entry.authorization.action] : [],
				),
				project_ids: suite.cases.flatMap((entry) =>
					entry.authorization?.resource.source === 'stored' &&
					entry.authorization.resource.project_id
						? [entry.authorization.resource.project_id]
						: [],
				),
				valid: result.valid,
				passed,
				failed: cases.length - passed,
			}),
	);
	return c.json({ success: true, data: result }, 200);
});

export default app;
