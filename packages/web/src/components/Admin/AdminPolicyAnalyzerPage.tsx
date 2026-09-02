import { useDeferredValue, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
	AlertTriangle,
	Braces,
	CheckCircle2,
	ChevronDown,
	Download,
	FileJson,
	Info,
	LockKeyhole,
	Play,
	Plus,
	ShieldCheck,
	Upload,
	XCircle,
} from 'lucide-react';
import { Button, Chip, PageContainer, PageHeader, TextField } from '@/components/ui';
import {
	useAdminUsersQuery,
	useEvaluatePolicySuite,
	usePolicyAnalyzerMetadataQuery,
	useProjectPickerQuery,
} from '@/api/hooks';
import { useAuth } from '@/context/AuthContext';
import { triggerDownload } from '@/lib/download';
import type { PolicySuiteResult, PolicySuiteV1 } from '@/types';

type PolicyCase = PolicySuiteV1['cases'][number];
type Action = NonNullable<PolicyCase['authorization']>['action'];
type Entitlement = NonNullable<
	NonNullable<PolicyCase['authorization']>['subject']['entitlements']
>[number];
type DenialCategory = NonNullable<
	NonNullable<PolicyCase['authorization']>['expected']['denial_category']
>;
type SessionMode = NonNullable<NonNullable<PolicyCase['authorization']>['resource']['mode']>;

const DENIAL_CATEGORIES: readonly DenialCategory[] = [
	'lifecycle',
	'visibility',
	'role',
	'session',
	'standing',
	'constraint',
];
const MEMBER_ROLES = ['viewer', 'editor', 'manager', 'admin'] as const;
const INITIAL_SUITE = JSON.stringify(
	{ schema_version: 1, name: 'Policy suite', cases: [] },
	null,
	2,
);
const inputClass =
	'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const textAreaClass =
	'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

function parseObject(value: string, label: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${label} must be a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function parseSuite(value: string, options?: { allowEmpty?: boolean }): PolicySuiteV1 {
	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('The suite must be a JSON object.');
	}
	const candidate = parsed as { schema_version?: unknown; cases?: unknown };
	if (candidate.schema_version !== 1) throw new Error('Use suite schema version 1.');
	if (!Array.isArray(candidate.cases)) throw new Error('The suite must contain a cases array.');
	if (!options?.allowEmpty && candidate.cases.length === 0) {
		throw new Error('Add at least 1 case before you run the suite.');
	}
	return parsed as PolicySuiteV1;
}

function assertSuiteLimit(suite: PolicySuiteV1, maximum: number): void {
	if (suite.cases.length > maximum) {
		throw new Error(`A suite can contain at most ${maximum} cases.`);
	}
}

function list(value: string): string[] {
	return [
		...new Set(
			value
				.split(',')
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
}

function title(value: string): string {
	return value
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function traceText(code: string): string {
	const known: Record<string, string> = {
		action_rule_loaded: 'Loaded the production rule for this action.',
		project_active: 'The project is active, so evaluation can continue.',
		project_deleted: 'The project is deleted, so authorization stops.',
		resource_unlabeled: 'No resource labels apply to this decision.',
		baseline_denied: 'Role or session policy denied access before label evaluation.',
		resource_constraints_satisfied: 'The subject context satisfies every resource label.',
		resource_constraints_constraint: 'The subject context does not satisfy the resource labels.',
		resource_constraints_missing_context: 'A valid subject context is required for this resource.',
		resource_constraints_unavailable: 'The constraint policy did not return a trusted decision.',
		session_rule_satisfied: 'The session rule permits this action.',
		session_rule_denied: 'The session rule denies this action.',
		session_start_satisfied: 'The role and viewer mode permit this session mode.',
		session_start_denied: 'The role or viewer mode denies this session mode.',
		super_admin_standing_satisfied: 'The subject has the required deployment standing.',
		super_admin_standing_missing: 'The subject lacks the required deployment standing.',
		deployment_standing_satisfied: 'The deployment rule permits this action.',
		deployment_standing_missing: 'The deployment rule denies this action.',
		authorization_allowed: 'The final authorization decision allows the action.',
	};
	if (known[code]) return known[code];
	if (code.startsWith('effective_role_')) {
		return `The effective role comes from ${code.slice('effective_role_'.length).replaceAll('-', ' ')}.`;
	}
	if (code.startsWith('authorization_denied_')) {
		return `The final decision denies the action because of ${code.slice('authorization_denied_'.length)} policy.`;
	}
	return code.replaceAll('_', ' ');
}

function problemText(code: string): string {
	const messages: Record<string, string> = {
		login_policy_unavailable:
			'No login policy is configured. Disable the login stage and run again.',
		login_policy_timeout:
			'The login policy timed out. Reduce policy work or increase its configured timeout.',
		login_policy_error:
			'The login policy failed. Check the policy module logs for the bounded error.',
		login_policy_invalid_result:
			'The login policy returned an invalid contract result. Fix the module output.',
		linked_login_stage_required: 'Login-derived entitlements require a login stage in this case.',
		live_context_requires_self:
			'Live context is limited to the signed-in admin. Use synthetic context for another subject.',
		stored_resource_inaccessible:
			'The stored resource is missing or not readable by the signed-in admin. Use a hypothetical resource instead.',
		stored_notebook_session_mismatch:
			'The selected notebook does not own this session. Clear the notebook or select the matching one.',
	};
	return messages[code] ?? code.replaceAll('_', ' ');
}

function StepCard({
	number,
	title: heading,
	description,
	children,
}: {
	number: number;
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<section className="rounded-xl border bg-card p-5 shadow-xs">
			<header className="mb-5 flex gap-3">
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary tabular-nums">
					{number}
				</span>
				<div className="min-w-0">
					<h2 className="font-semibold text-pretty">{heading}</h2>
					<p className="mt-0.5 text-sm text-muted-foreground text-pretty">{description}</p>
				</div>
			</header>
			{children}
		</section>
	);
}

function AdvancedSection({
	title: heading,
	summary,
	children,
}: {
	title: string;
	summary: string;
	children: ReactNode;
}) {
	return (
		<details className="group mt-4 overflow-hidden rounded-lg border bg-muted/15">
			<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
				<span className="min-w-0">
					<span className="font-medium">{heading}</span>
					<span className="ml-2 text-xs text-muted-foreground">{summary}</span>
				</span>
				<ChevronDown
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
				/>
			</summary>
			<div className="border-t px-3 py-4">{children}</div>
		</details>
	);
}

function ResultCard({ result }: { result: PolicySuiteResult }) {
	const singleCase = result.summary.case_count === 1;
	return (
		<section
			className="mt-8 flex flex-col gap-4"
			aria-label="Policy analysis result"
			aria-live="polite"
		>
			<div
				className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${
					result.valid
						? 'border-emerald-600/30 bg-emerald-500/5'
						: 'border-destructive/30 bg-destructive/5'
				}`}
			>
				<div className="flex items-center gap-3">
					{result.valid ? (
						<CheckCircle2 aria-hidden="true" className="size-6 text-emerald-600" />
					) : (
						<XCircle aria-hidden="true" className="size-6 text-destructive" />
					)}
					<div>
						<h2 className="font-semibold text-balance">
							{singleCase ? 'Scenario' : 'Suite'} {result.valid ? 'Passed' : 'Failed'}
						</h2>
						<p className="text-sm text-muted-foreground">
							{result.valid
								? 'The policy result matches every expectation.'
								: 'Review the expected and actual results below.'}
						</p>
					</div>
				</div>
				<p className="text-sm tabular-nums">
					<span className="font-medium text-emerald-700 dark:text-emerald-400">
						{result.summary.passed} passed
					</span>
					<span className="text-muted-foreground"> · </span>
					<span className={result.summary.failed > 0 ? 'font-medium text-destructive' : ''}>
						{result.summary.failed} failed
					</span>
				</p>
			</div>

			{result.cases.map((entry) => {
				const expectedAllowed = entry.authorization?.assertion.expected.allowed === true;
				const expectedCategory = entry.authorization?.assertion.expected.denial_category;
				const actualAllowed = entry.authorization?.decision.allowed;
				const expectedEntitlements = entry.login?.assertion.expected.entitlements;
				const expectedEntitlementList = Array.isArray(expectedEntitlements)
					? expectedEntitlements.filter((value): value is string => typeof value === 'string')
					: [];
				return (
					<article key={entry.id} className="overflow-hidden rounded-xl border bg-card">
						<header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
							<div className="min-w-0">
								<h3 className="truncate font-medium">{entry.name}</h3>
								<code translate="no" className="break-all text-xs text-muted-foreground">
									{entry.id}
								</code>
							</div>
							<Chip className={entry.valid ? 'text-emerald-700' : 'text-destructive'}>
								{entry.valid ? 'Passed' : 'Failed'}
							</Chip>
						</header>
						<div className="flex flex-col gap-5 p-4">
							{entry.login ? (
								<section aria-label="Login policy result">
									<div className="flex flex-wrap items-center gap-2">
										<h4 className="text-sm font-medium">Login Policy</h4>
										<Chip>{title(entry.login.outcome)}</Chip>
										<Chip
											className={
												entry.login.assertion.passed ? 'text-emerald-700' : 'text-destructive'
											}
										>
											Expectation {entry.login.assertion.passed ? 'Matched' : 'Mismatched'}
										</Chip>
									</div>
									<p className="mt-2 text-sm text-muted-foreground tabular-nums">
										Expected{' '}
										<strong className="text-foreground">
											{title(String(entry.login.assertion.expected.outcome))}
										</strong>
										{' · '}Received{' '}
										<strong className="text-foreground">{title(entry.login.outcome)}</strong>
										{' · '}
										{entry.login.duration_ms} ms
									</p>
									{entry.login.outcome === 'allow' || expectedEntitlementList.length > 0 ? (
										<div className="mt-3 grid gap-3 rounded-lg bg-muted/30 p-3 sm:grid-cols-2">
											<div>
												<p className="mb-1.5 text-xs text-muted-foreground">
													Expected Entitlements
												</p>
												<div className="flex flex-wrap gap-1.5">
													{expectedEntitlementList.length > 0 ? (
														expectedEntitlementList.map((entitlement) => (
															<Chip key={entitlement}>{entitlement}</Chip>
														))
													) : (
														<span className="text-xs">None</span>
													)}
												</div>
											</div>
											<div>
												<p className="mb-1.5 text-xs text-muted-foreground">
													Received Entitlements
												</p>
												<div className="flex flex-wrap gap-1.5">
													{entry.login.entitlements.length > 0 ? (
														entry.login.entitlements.map((entitlement) => (
															<Chip key={entitlement}>{entitlement}</Chip>
														))
													) : (
														<span className="text-xs">None</span>
													)}
												</div>
											</div>
										</div>
									) : null}
								</section>
							) : null}

							{entry.authorization ? (
								<section aria-label="Authorization result">
									<div className="flex flex-wrap items-center gap-2">
										<h4 className="text-sm font-medium">Authorization</h4>
										<Chip>{actualAllowed ? 'Allowed' : 'Denied'}</Chip>
										<Chip>{title(entry.authorization.presentation)}</Chip>
										{entry.authorization.decision.role ? (
											<Chip>{title(entry.authorization.decision.role)} Role</Chip>
										) : null}
									</div>
									<div
										className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
											entry.authorization.assertion.passed
												? 'border-emerald-600/20 bg-emerald-500/5'
												: 'border-destructive/30 bg-destructive/5'
										}`}
									>
										Expected{' '}
										<strong>
											{expectedAllowed ? 'Allow' : 'Deny'}
											{typeof expectedCategory === 'string' ? ` (${title(expectedCategory)})` : ''}
										</strong>
										{' · '}Received{' '}
										<strong>
											{actualAllowed ? 'Allow' : 'Deny'}
											{entry.authorization.decision.category
												? ` (${title(entry.authorization.decision.category)})`
												: ''}
										</strong>
									</div>
									<ol className="mt-4 flex flex-col gap-2" aria-label="Decision trace">
										{entry.authorization.trace.map((step) => (
											<li key={`${step.stage}-${step.code}`} className="flex gap-3 text-sm">
												{step.status === 'passed' ? (
													<CheckCircle2
														aria-hidden="true"
														className="mt-0.5 size-4 shrink-0 text-emerald-600"
													/>
												) : step.status === 'failed' ? (
													<XCircle
														aria-hidden="true"
														className="mt-0.5 size-4 shrink-0 text-destructive"
													/>
												) : (
													<span
														aria-hidden="true"
														className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground"
													/>
												)}
												<div className="min-w-0 flex-1">
													<div className="flex flex-wrap items-baseline gap-x-2">
														<span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
															{step.stage}
														</span>
														<p className="break-words">{traceText(step.code)}</p>
													</div>
													{step.details ? (
														<details className="mt-1">
															<summary className="cursor-pointer text-xs text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
																View Structured Evidence
															</summary>
															<pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all">
																{JSON.stringify(step.details, null, 2)}
															</pre>
														</details>
													) : null}
												</div>
											</li>
										))}
									</ol>
								</section>
							) : entry.login?.outcome === 'deny' ? (
								<p className="rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
									Authorization was skipped because the login policy denied this subject.
								</p>
							) : null}

							{entry.errors.length > 0 ? (
								<div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
									<p className="font-medium">The analyzer could not complete this case.</p>
									<ul className="mt-1 list-disc space-y-1 pl-5">
										{entry.errors.map((error) => (
											<li key={`${error.stage}-${error.code}`}>{problemText(error.code)}</li>
										))}
									</ul>
								</div>
							) : null}
						</div>
					</article>
				);
			})}
		</section>
	);
}

export default function AdminPolicyAnalyzerPage() {
	const { data: metadata } = usePolicyAnalyzerMetadataQuery();
	const { data: users } = useAdminUsersQuery();
	const projects = useProjectPickerQuery(true);
	const { user } = useAuth();
	const run = useEvaluatePolicySuite();
	const fileInput = useRef<HTMLInputElement>(null);
	const errorRef = useRef<HTMLDivElement>(null);
	const firstUser = user ?? users[0];
	const [caseName, setCaseName] = useState('Policy check');
	const [subjectId, setSubjectId] = useState(firstUser?.id ?? 'test-user');
	const [subjectEmail, setSubjectEmail] = useState(firstUser?.email ?? 'test@example.com');
	const [action, setAction] = useState<Action>('project.read');
	const [source, setSource] = useState<'stored' | 'synthetic'>('synthetic');
	const [projectId, setProjectId] = useState('');
	const [notebookId, setNotebookId] = useState('');
	const [sessionId, setSessionId] = useState('');
	const [expectedAllowed, setExpectedAllowed] = useState(true);
	const [expectedDenialCategory, setExpectedDenialCategory] = useState<DenialCategory | ''>('');
	const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
	const [loginEnabled, setLoginEnabled] = useState(false);
	const [expectedLoginOutcome, setExpectedLoginOutcome] = useState<'allow' | 'deny'>('allow');
	const [idClaims, setIdClaims] = useState('{\n  "groups": []\n}');
	const [userInfoClaims, setUserInfoClaims] = useState('');
	const [contextMode, setContextMode] = useState<'synthetic' | 'live-self'>('synthetic');
	const [relationship, setRelationship] = useState<'owner' | 'member' | 'none'>('owner');
	const [memberRole, setMemberRole] = useState<(typeof MEMBER_ROLES)[number]>('viewer');
	const [projectStatus, setProjectStatus] = useState<'active' | 'deleted'>('active');
	const [sessionMode, setSessionMode] = useState<SessionMode>('edit');
	const [heldClassification, setHeldClassification] = useState('');
	const [heldCompartments, setHeldCompartments] = useState('');
	const [requiredClassification, setRequiredClassification] = useState('');
	const [requiredCompartments, setRequiredCompartments] = useState('');
	const [formError, setFormError] = useState<string | null>(null);
	const [suiteNotice, setSuiteNotice] = useState<string | null>(null);
	const [suiteText, setSuiteText] = useState(() => INITIAL_SUITE);
	const deferredSuiteText = useDeferredValue(suiteText);

	const actionRule = useMemo(
		() => metadata.actions.find((entry) => entry.action === action),
		[action, metadata.actions],
	);
	const scope = actionRule?.scope ?? 'project';
	const suiteInfo = useMemo(() => {
		try {
			const suite = parseSuite(deferredSuiteText, { allowEmpty: true });
			assertSuiteLimit(suite, metadata.max_cases);
			return { valid: true as const, count: suite.cases.length };
		} catch (error) {
			return {
				valid: false as const,
				count: 0,
				message: error instanceof Error ? error.message : 'The suite is invalid.',
			};
		}
	}, [deferredSuiteText, metadata.max_cases]);

	function selectUser(id: string) {
		const selected = users.find((entry) => entry.id === id);
		setSubjectId(id);
		if (selected) setSubjectEmail(selected.email);
	}

	function reportError(error: unknown, fallback: string) {
		setFormError(error instanceof Error ? error.message : fallback);
		requestAnimationFrame(() => errorRef.current?.focus());
	}

	function buildCase(): PolicyCase {
		if (!caseName.trim()) throw new Error('Enter a case name.');
		if (!subjectId.trim()) throw new Error('Enter a subject ID.');
		if (!subjectEmail.trim()) throw new Error('Enter a subject email.');
		if (scope !== 'deployment' && source === 'stored' && !projectId) {
			throw new Error('Select a stored project, or use a hypothetical resource.');
		}
		if (scope === 'session' && source === 'stored' && !sessionId.trim()) {
			throw new Error('Enter the stored session ID.');
		}
		const labels = requiredClassification
			? { classification: requiredClassification, compartments: list(requiredCompartments) }
			: undefined;
		const resource: NonNullable<PolicyCase['authorization']>['resource'] =
			scope === 'deployment'
				? { source: 'synthetic', kind: 'deployment' }
				: source === 'stored'
					? {
							source,
							kind: scope,
							project_id: projectId,
							...(notebookId.trim() ? { notebook_id: notebookId.trim() } : {}),
							...(sessionId.trim() ? { session_id: sessionId.trim() } : {}),
							...(scope === 'session-start' ? { mode: sessionMode } : {}),
						}
					: {
							source,
							kind: scope,
							project: {
								owner: relationship === 'owner' ? subjectId.trim() : 'policy-owner',
								members:
									relationship === 'member'
										? [{ user_id: subjectId.trim(), role: memberRole }]
										: [],
								status: projectStatus,
								...(labels ? { security_labels: labels } : {}),
							},
							...(scope === 'session'
								? { session: { mode: sessionMode, user_id: subjectId.trim() } }
								: {}),
							...(scope === 'session-start' ? { mode: sessionMode } : {}),
						};
		return {
			id: `case-${Date.now()}`,
			name: caseName.trim(),
			...(loginEnabled
				? {
						login: {
							identity: { id: subjectId.trim(), email: subjectEmail.trim() },
							id_token_claims: parseObject(idClaims, 'ID-token claims'),
							...(userInfoClaims.trim()
								? { user_info_claims: parseObject(userInfoClaims, 'UserInfo claims') }
								: {}),
							expected: {
								outcome: expectedLoginOutcome,
								...(expectedLoginOutcome === 'allow' ? { entitlements } : {}),
							},
						},
					}
				: {}),
			authorization: {
				subject: {
					id: subjectId.trim(),
					email: subjectEmail.trim(),
					entitlement_source: loginEnabled ? 'login' : 'explicit',
					...(!loginEnabled ? { entitlements } : {}),
				},
				action,
				resource,
				context:
					contextMode === 'live-self'
						? { mode: 'live-self' }
						: {
								mode: 'synthetic',
								value: heldClassification
									? {
											schemaVersion: 1,
											classification: heldClassification,
											compartments: list(heldCompartments),
											policyVersion: 'policy-analyzer',
											expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
										}
									: null,
							},
				expected: {
					allowed: expectedAllowed,
					...(!expectedAllowed && expectedDenialCategory
						? { denial_category: expectedDenialCategory }
						: {}),
				},
			},
		};
	}

	function runOne() {
		try {
			setFormError(null);
			setSuiteNotice(null);
			run.mutate({ schema_version: 1, cases: [buildCase()] });
		} catch (error) {
			reportError(error, 'The scenario is invalid.');
		}
	}

	function addToSuite() {
		try {
			const suite = parseSuite(suiteText, { allowEmpty: true });
			if (suite.cases.length >= metadata.max_cases) {
				throw new Error(`A suite can contain at most ${metadata.max_cases} cases.`);
			}
			setSuiteText(JSON.stringify({ ...suite, cases: [...suite.cases, buildCase()] }, null, 2));
			setFormError(null);
			setSuiteNotice('Added the scenario to the local JSON suite.');
		} catch (error) {
			reportError(error, 'The suite is invalid.');
		}
	}

	function runSuite() {
		try {
			const suite = parseSuite(suiteText);
			assertSuiteLimit(suite, metadata.max_cases);
			setFormError(null);
			setSuiteNotice(null);
			run.mutate(suite);
		} catch (error) {
			reportError(error, 'The suite is not valid JSON.');
		}
	}

	return (
		<PageContainer contentClassName="max-w-6xl">
			<PageHeader>
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-balance">Policy Analyzer</h1>
					<p className="mt-1 max-w-3xl text-sm text-muted-foreground text-pretty">
						Test a policy decision without changing access. The analyzer runs the production login
						and authorization evaluators, then compares the result with your expectation.
					</p>
				</div>
			</PageHeader>

			<div className="mb-6 grid gap-3 sm:grid-cols-3">
				<div className="flex gap-3 rounded-lg border bg-card px-3 py-3">
					<ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
					<div>
						<p className="text-sm font-medium">Deterministic</p>
						<p className="text-xs text-muted-foreground">No generated reasoning</p>
					</div>
				</div>
				<div className="flex gap-3 rounded-lg border bg-card px-3 py-3">
					<LockKeyhole aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
					<div>
						<p className="text-sm font-medium">Read-Only</p>
						<p className="text-xs text-muted-foreground">No policy or access changes</p>
					</div>
				</div>
				<div className="flex gap-3 rounded-lg border bg-card px-3 py-3">
					<Braces aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
					<div>
						<p className="text-sm font-medium">Versioned</p>
						<p className="text-xs text-muted-foreground">Portable version 1 suites</p>
					</div>
				</div>
			</div>

			<div className="mb-6 flex flex-wrap gap-2" aria-label="Analyzer capabilities">
				<Chip>
					Login Policy: {metadata.capabilities.login_policy ? 'Available' : 'Not Configured'}
				</Chip>
				<Chip>
					Resource Security:{' '}
					{metadata.capabilities.resource_security ? 'Available' : 'Not Configured'}
				</Chip>
				<Chip>{metadata.max_cases} Cases Maximum</Chip>
			</div>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
				<main className="flex min-w-0 flex-col gap-5">
					<StepCard
						number={1}
						title="Choose the Subject"
						description="Select a known user or enter a hypothetical identity."
					>
						<div className="grid gap-3 sm:grid-cols-2">
							<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
								Known User
								<select
									name="known-user"
									autoComplete="off"
									className={inputClass}
									value={users.some((entry) => entry.id === subjectId) ? subjectId : ''}
									onChange={(event) => {
										if (event.target.value) selectUser(event.target.value);
									}}
								>
									<option value="">Hypothetical user</option>
									{users.map((entry) => (
										<option key={entry.id} value={entry.id}>
											{entry.name} · {entry.email}
										</option>
									))}
								</select>
							</label>
							<TextField label="Subject ID" value={subjectId} onChange={setSubjectId} />
							<TextField label="Subject Email" value={subjectEmail} onChange={setSubjectEmail} />
							<TextField label="Case Name" value={caseName} onChange={setCaseName} />
						</div>

						<AdvancedSection
							title="Entitlements & Standing"
							summary={`${entitlements.length} selected`}
						>
							<p className="mb-3 text-xs text-muted-foreground">
								{loginEnabled
									? 'Select the exact normalized entitlements expected from login. An allowed login passes them to authorization.'
									: 'Explicit entitlements affect deployment standing and default roles.'}
							</p>
							<div className="grid gap-2 sm:grid-cols-2">
								{metadata.entitlements.map((entitlement) => (
									<label
										key={entitlement}
										className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted/50"
									>
										<input
											type="checkbox"
											aria-label={entitlement}
											checked={entitlements.includes(entitlement)}
											onChange={(event) =>
												setEntitlements((current) =>
													event.target.checked
														? [...current, entitlement]
														: current.filter((item) => item !== entitlement),
												)
											}
										/>
										<code translate="no" className="break-all">
											{entitlement}
										</code>
									</label>
								))}
							</div>
						</AdvancedSection>

						<div className="mt-4 rounded-lg border bg-muted/20 p-3">
							<label
								aria-label="Evaluate the login policy"
								className="flex items-start gap-3 text-sm"
							>
								<input
									type="checkbox"
									aria-label="Evaluate the login policy"
									className="mt-1"
									checked={loginEnabled}
									disabled={!metadata.capabilities.login_policy}
									onChange={(event) => setLoginEnabled(event.target.checked)}
								/>
								<span>
									<span className="font-medium">Evaluate the Login Policy</span>
									<span className="mt-0.5 block text-xs text-muted-foreground">
										{metadata.capabilities.login_policy
											? 'Use sample claims and pass allowed entitlements to authorization.'
											: 'No login policy is configured for this deployment.'}
									</span>
								</span>
							</label>
							{loginEnabled ? (
								<div className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2">
									<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
										Expected Login Decision
										<select
											name="expected-login-decision"
											autoComplete="off"
											className={inputClass}
											value={expectedLoginOutcome}
											onChange={(event) =>
												setExpectedLoginOutcome(event.target.value as 'allow' | 'deny')
											}
										>
											<option value="allow">Allow</option>
											<option value="deny">Deny</option>
										</select>
									</label>
									<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
										ID-Token Claims
										<textarea
											aria-label="ID-token claims"
											name="id-token-claims"
											autoComplete="off"
											spellCheck={false}
											className={textAreaClass}
											rows={6}
											value={idClaims}
											onChange={(event) => setIdClaims(event.target.value)}
										/>
									</label>
									<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
										UserInfo Claims <span className="font-normal">(Optional)</span>
										<textarea
											aria-label="UserInfo claims"
											name="userinfo-claims"
											autoComplete="off"
											spellCheck={false}
											className={textAreaClass}
											rows={4}
											placeholder={'{\n  "department": "analytics"\n}'}
											value={userInfoClaims}
											onChange={(event) => setUserInfoClaims(event.target.value)}
										/>
									</label>
								</div>
							) : null}
						</div>
					</StepCard>

					<StepCard
						number={2}
						title="Choose the Action & Resource"
						description="The selected action controls which resource fields and rules apply."
					>
						<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
							Action
							<select
								name="authorization-action"
								autoComplete="off"
								className={inputClass}
								value={action}
								onChange={(event) => setAction(event.target.value as Action)}
							>
								{metadata.actions.map((entry) => (
									<option key={entry.action} value={entry.action}>
										{entry.action}
									</option>
								))}
							</select>
						</label>
						<div className="mt-3 flex gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
							<Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
							<p>
								Scope: <code translate="no">{scope}</code>
								{actionRule?.minimum_role ? ` · Minimum role: ${actionRule.minimum_role}` : ''}
								{actionRule?.requires_super_admin ? ' · Requires super admin' : ''}
								{actionRule?.denied_as ? ` · Denial appears as ${actionRule.denied_as}` : ''}
							</p>
						</div>

						{scope !== 'deployment' ? (
							<>
								<fieldset className="mt-4">
									<legend className="text-xs font-medium text-muted-foreground">
										Resource Source
									</legend>
									<div className="mt-1.5 grid grid-cols-2 gap-2">
										{(['synthetic', 'stored'] as const).map((value) => (
											<label
												key={value}
												className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${
													source === value
														? 'border-primary bg-primary/5 text-primary'
														: 'hover:bg-muted/50'
												}`}
											>
												<input
													type="radio"
													aria-label={value === 'synthetic' ? 'Hypothetical' : 'Stored resource'}
													name="resource-source"
													checked={source === value}
													onChange={() => setSource(value)}
												/>
												{value === 'synthetic' ? 'Hypothetical' : 'Stored Resource'}
											</label>
										))}
									</div>
								</fieldset>

								{source === 'stored' ? (
									<div className="mt-4 grid gap-3 sm:grid-cols-2">
										<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
											Project
											<select
												name="stored-project"
												autoComplete="off"
												className={inputClass}
												value={projectId}
												onChange={(event) => setProjectId(event.target.value)}
											>
												<option value="">Select a project…</option>
												{(projects.data ?? []).map((project) => (
													<option key={project.id} value={project.id}>
														{project.name}
													</option>
												))}
											</select>
										</label>
										<TextField
											label="Notebook ID (Optional)"
											value={notebookId}
											onChange={setNotebookId}
										/>
										{scope === 'session' ? (
											<TextField label="Session ID" value={sessionId} onChange={setSessionId} />
										) : null}
									</div>
								) : (
									<div className="mt-4 grid gap-3 sm:grid-cols-2">
										<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
											Subject Relationship
											<select
												name="subject-relationship"
												autoComplete="off"
												className={inputClass}
												value={relationship}
												onChange={(event) =>
													setRelationship(event.target.value as typeof relationship)
												}
											>
												<option value="owner">Project Owner</option>
												<option value="member">Project Member</option>
												<option value="none">No Relationship</option>
											</select>
										</label>
										{relationship === 'member' ? (
											<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
												Member Role
												<select
													name="member-role"
													autoComplete="off"
													className={inputClass}
													value={memberRole}
													onChange={(event) =>
														setMemberRole(event.target.value as typeof memberRole)
													}
												>
													{MEMBER_ROLES.map((role) => (
														<option key={role} value={role}>
															{title(role)}
														</option>
													))}
												</select>
											</label>
										) : null}
									</div>
								)}

								{scope === 'session-start' || (scope === 'session' && source === 'synthetic') ? (
									<label className="mt-3 flex max-w-xs flex-col gap-1.5 text-xs font-medium text-muted-foreground">
										Session Mode
										<select
											name="session-mode"
											autoComplete="off"
											className={inputClass}
											value={sessionMode}
											onChange={(event) => setSessionMode(event.target.value as SessionMode)}
										>
											<option value="edit">Edit</option>
											<option value="run">Run</option>
										</select>
									</label>
								) : null}

								{source === 'synthetic' ? (
									<AdvancedSection
										title="Resource Lifecycle & Labels"
										summary={requiredClassification || title(projectStatus)}
									>
										<div className="grid gap-3 sm:grid-cols-2">
											<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
												Project Status
												<select
													name="project-status"
													autoComplete="off"
													className={inputClass}
													value={projectStatus}
													onChange={(event) =>
														setProjectStatus(event.target.value as typeof projectStatus)
													}
												>
													<option value="active">Active</option>
													<option value="deleted">Deleted</option>
												</select>
											</label>
											<TextField
												label="Required Classification"
												placeholder={`${metadata.classification_order[0] ?? 'LEVEL_1'}…`}
												value={requiredClassification}
												onChange={setRequiredClassification}
											/>
											<TextField
												label="Required Compartments"
												placeholder="team-a, project-b…"
												value={requiredCompartments}
												onChange={setRequiredCompartments}
											/>
										</div>
										{metadata.classification_order.length > 0 ? (
											<div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
												<span>Configured order:</span>
												{metadata.classification_order.map((classification) => (
													<Chip key={classification}>{classification}</Chip>
												))}
											</div>
										) : null}
									</AdvancedSection>
								) : null}
							</>
						) : (
							<p className="mt-3 text-sm text-muted-foreground">
								This deployment-scoped action does not require a project or session resource.
							</p>
						)}
					</StepCard>

					<StepCard
						number={3}
						title="Set the Expected Result"
						description="A scenario passes only when the actual decision matches this expectation."
					>
						<div className="grid gap-3 sm:grid-cols-2">
							<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
								Expected Authorization Decision
								<select
									name="expected-authorization-decision"
									autoComplete="off"
									className={inputClass}
									value={expectedAllowed ? 'allow' : 'deny'}
									onChange={(event) => setExpectedAllowed(event.target.value === 'allow')}
								>
									<option value="allow">Allow</option>
									<option value="deny">Deny</option>
								</select>
							</label>
							{!expectedAllowed ? (
								<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
									Expected Denial Category <span className="font-normal">(Optional)</span>
									<select
										name="expected-denial-category"
										autoComplete="off"
										className={inputClass}
										value={expectedDenialCategory}
										onChange={(event) =>
											setExpectedDenialCategory(event.target.value as DenialCategory | '')
										}
									>
										<option value="">Any denial category</option>
										{DENIAL_CATEGORIES.map((category) => (
											<option key={category} value={category}>
												{title(category)}
											</option>
										))}
									</select>
								</label>
							) : null}
						</div>
						{loginEnabled && expectedLoginOutcome === 'deny' ? (
							<div className="mt-3 flex gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
								<Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
								<p>
									A denied login skips authorization. The authorization expectation applies only if
									the login policy unexpectedly allows this subject.
								</p>
							</div>
						) : null}

						{metadata.capabilities.resource_security ? (
							<AdvancedSection
								title="Subject Security Context"
								summary={contextMode === 'live-self' ? 'Live self' : heldClassification || 'None'}
							>
								<div className="grid gap-3 sm:grid-cols-2">
									<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
										Context Source
										<select
											name="context-source"
											autoComplete="off"
											className={inputClass}
											value={contextMode}
											onChange={(event) => setContextMode(event.target.value as typeof contextMode)}
										>
											<option value="synthetic">Synthetic Context</option>
											<option value="live-self" disabled={!metadata.capabilities.live_self_context}>
												Live Context for Signed-In Admin
											</option>
										</select>
									</label>
									{contextMode === 'synthetic' ? (
										<>
											<TextField
												label="Held Classification"
												placeholder={`${metadata.classification_order.at(-1) ?? 'LEVEL_3'}…`}
												value={heldClassification}
												onChange={setHeldClassification}
											/>
											<TextField
												label="Held Compartments"
												placeholder="team-a, project-b…"
												value={heldCompartments}
												onChange={setHeldCompartments}
											/>
										</>
									) : (
										<p className="self-end text-xs text-muted-foreground">
											Live context is available only for the signed-in admin.
										</p>
									)}
								</div>
							</AdvancedSection>
						) : null}
					</StepCard>
				</main>

				<aside className="min-w-0 self-start rounded-xl border bg-card p-4 shadow-xs xl:sticky xl:top-4">
					<h2 className="font-semibold">Scenario Summary</h2>
					<dl className="mt-4 space-y-3 text-sm">
						<div>
							<dt className="text-xs text-muted-foreground">Subject</dt>
							<dd className="truncate font-medium" title={subjectEmail}>
								{subjectEmail}
							</dd>
						</div>
						<div>
							<dt className="text-xs text-muted-foreground">Action</dt>
							<dd>
								<code translate="no" className="break-all font-medium">
									{action}
								</code>
							</dd>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<div>
								<dt className="text-xs text-muted-foreground">Resource</dt>
								<dd className="font-medium">
									{scope === 'deployment'
										? 'Deployment'
										: source === 'stored'
											? 'Stored'
											: 'Hypothetical'}
								</dd>
							</div>
							<div>
								<dt className="text-xs text-muted-foreground">Authorization</dt>
								<dd className="font-medium">
									{expectedAllowed ? 'Allow' : 'Deny'}
									{loginEnabled && expectedLoginOutcome === 'deny' ? ' (Conditional)' : ''}
								</dd>
							</div>
						</div>
						{loginEnabled ? (
							<div>
								<dt className="text-xs text-muted-foreground">Login</dt>
								<dd className="font-medium">{title(expectedLoginOutcome)}</dd>
							</div>
						) : null}
					</dl>

					<div className="mt-5 border-t pt-4">
						<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Stages to Run
						</p>
						<ol className="mt-3 space-y-2 text-sm">
							<li className="flex items-center gap-2">
								<span
									className={`flex size-5 items-center justify-center rounded-full ${loginEnabled ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
								>
									1
								</span>
								<span className={loginEnabled ? '' : 'text-muted-foreground'}>
									Login Policy {loginEnabled ? '' : '(Skipped)'}
								</span>
							</li>
							<li className="flex items-center gap-2">
								<span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
									2
								</span>
								Authorization
								{loginEnabled && expectedLoginOutcome === 'deny' ? ' (Skipped on Deny)' : ''}
							</li>
							<li className="flex items-center gap-2">
								<span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
									3
								</span>
								Expectation Check
							</li>
						</ol>
					</div>

					<div className="mt-5 flex flex-col gap-2">
						<Button
							variant="primary"
							onPress={runOne}
							isDisabled={run.isPending}
							className="w-full"
						>
							<Play aria-hidden="true" className="size-4" />
							{run.isPending ? 'Running…' : 'Run Scenario'}
						</Button>
						<Button onPress={addToSuite} isDisabled={run.isPending} className="w-full">
							<Plus aria-hidden="true" className="size-4" /> Add to JSON Suite
						</Button>
					</div>
					<p className="mt-3 text-center text-xs text-muted-foreground">
						Each run creates 1 bounded audit event.
					</p>
				</aside>
			</div>

			<div aria-live="polite" aria-atomic="true">
				{formError ? (
					<div
						ref={errorRef}
						tabIndex={-1}
						role="alert"
						className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<p className="font-medium">The scenario is not ready.</p>
						<p>{formError}</p>
					</div>
				) : null}
				{run.error ? (
					<div
						role="alert"
						className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive"
					>
						<p className="font-medium">The analyzer request failed.</p>
						<p>{run.error.message}</p>
					</div>
				) : null}
				{suiteNotice ? (
					<p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">{suiteNotice}</p>
				) : null}
			</div>

			{run.data ? <ResultCard result={run.data} /> : null}

			<details className="group mt-8 overflow-hidden rounded-xl border bg-card">
				<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
					<div className="flex min-w-0 items-center gap-3">
						<FileJson aria-hidden="true" className="size-5 shrink-0 text-primary" />
						<div className="min-w-0">
							<h2 className="font-semibold">JSON Test Suite</h2>
							<p className="text-xs text-muted-foreground">
								{suiteInfo.valid
									? `${suiteInfo.count} of ${metadata.max_cases} local cases · Version 1`
									: suiteInfo.message}
							</p>
						</div>
					</div>
					<ChevronDown
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
					/>
				</summary>
				<div className="border-t p-4">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="max-w-2xl text-sm text-muted-foreground">
							Edit the exact portable suite contract, or import a version 1 file.
						</p>
						<div className="flex gap-1">
							<Button variant="ghost" size="sm" onPress={() => fileInput.current?.click()}>
								<Upload aria-hidden="true" className="size-4" /> Import JSON
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onPress={() =>
									triggerDownload(
										'policy-suite.json',
										new Blob([suiteText], { type: 'application/json' }),
									)
								}
							>
								<Download aria-hidden="true" className="size-4" /> Export JSON
							</Button>
						</div>
					</div>
					<input
						aria-label="Import JSON suite"
						ref={fileInput}
						type="file"
						accept="application/json,.json"
						className="hidden"
						onChange={(event) => {
							const file = event.target.files?.[0];
							if (file) {
								void file
									.text()
									.then((value) => {
										const suite = parseSuite(value, { allowEmpty: true });
										assertSuiteLimit(suite, metadata.max_cases);
										setSuiteText(value);
										setSuiteNotice(`Imported ${file.name}.`);
									})
									.catch((error: unknown) =>
										reportError(error, 'The suite file could not be read.'),
									);
							}
							event.target.value = '';
						}}
					/>
					<div className="mt-4 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
						<AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
						Exported suites can contain sensitive sample claims and subject context. Store them as
						sensitive data.
					</div>
					<textarea
						aria-label="JSON suite"
						name="json-suite"
						autoComplete="off"
						spellCheck={false}
						className={`${textAreaClass} mt-4 min-h-96`}
						value={suiteText}
						onChange={(event) => {
							setSuiteText(event.target.value);
							setSuiteNotice(null);
						}}
					/>
					<div className="mt-3 flex flex-wrap items-center justify-between gap-3">
						<p
							className={`text-xs ${suiteInfo.valid ? 'text-muted-foreground' : 'text-destructive'}`}
						>
							{suiteInfo.valid ? `${suiteInfo.count} cases ready locally` : suiteInfo.message}
						</p>
						<Button
							variant="primary"
							onPress={runSuite}
							isDisabled={run.isPending || !suiteInfo.valid}
						>
							<FileJson aria-hidden="true" className="size-4" />
							{run.isPending
								? 'Running…'
								: `Run Suite (${suiteInfo.count} ${suiteInfo.count === 1 ? 'Case' : 'Cases'})`}
						</Button>
					</div>
				</div>
			</details>
		</PageContainer>
	);
}
