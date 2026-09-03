import { useDeferredValue, useMemo, useRef, useState } from 'react';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	CircleDashed,
	Download,
	FileJson,
	Info,
	Play,
	Plus,
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
import type {
	AdminUser,
	PolicyAnalyzerMetadata,
	PolicySuiteResult,
	PolicySuiteV1,
	ProjectSummary,
} from '@/types';

type PolicyCase = PolicySuiteV1['cases'][number];
type Action = NonNullable<PolicyCase['authorization']>['action'];
type Entitlement = NonNullable<
	NonNullable<PolicyCase['authorization']>['subject']['entitlements']
>[number];
type DenialCategory = NonNullable<
	NonNullable<PolicyCase['authorization']>['expected']['denial_category']
>;
type SessionMode = NonNullable<NonNullable<PolicyCase['authorization']>['resource']['mode']>;
type ActionRule = PolicyAnalyzerMetadata['actions'][number];
type Scope = ActionRule['scope'];
type ResourceSource = 'stored' | 'synthetic';
type LoginOutcome = 'allow' | 'deny';
type ContextMode = 'synthetic' | 'live-self';
type Relationship = 'owner' | 'member' | 'none';
type MemberRole = (typeof MEMBER_ROLES)[number];
type ProjectStatus = 'active' | 'deleted';
type SuiteInfo = { valid: true; count: number } | { valid: false; count: 0; message: string };

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
		throw new Error('Add at least 1 scenario before you run the suite.');
	}
	return parsed as PolicySuiteV1;
}

function assertSuiteLimit(suite: PolicySuiteV1, maximum: number): void {
	if (suite.cases.length > maximum) {
		throw new Error(`A suite can contain at most ${maximum} scenarios.`);
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
		action_rule_loaded: 'The analyzer loaded the rule for this action.',
		project_active: 'The project is active. Evaluation continues.',
		project_deleted: 'The project is deleted, so authorization stops.',
		resource_unlabeled: 'No resource labels apply to this decision.',
		baseline_denied: 'The role or session rule denied access before the label check.',
		resource_constraints_satisfied: 'The subject meets every resource-label requirement.',
		resource_constraints_constraint: 'The subject does not meet the resource-label requirements.',
		resource_constraints_missing_context: 'This resource requires a valid security context.',
		resource_constraints_unavailable: 'The resource-label check did not return a trusted result.',
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
			'No login policy is configured. Remove the login check and run again.',
		login_policy_timeout:
			'The login policy timed out. Reduce policy work or increase its configured timeout.',
		login_policy_error: 'The login policy failed. Read the policy module logs for error details.',
		login_policy_invalid_result:
			'The login policy returned an invalid contract result. Fix the module output.',
		linked_login_stage_required: 'Include the login policy for this scenario.',
		live_context_requires_self:
			'Current security context is available only for the signed-in admin. Use test context for another subject.',
		stored_resource_inaccessible:
			'The stored resource does not exist, or the signed-in admin cannot read it. Use a test resource instead.',
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
								{!singleCase ? (
									<code translate="no" className="break-all text-xs text-muted-foreground">
										{entry.id}
									</code>
								) : null}
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
										<Chip>Decision: {actualAllowed ? 'Allowed' : 'Denied'}</Chip>
										{!actualAllowed ? (
											<Chip>Response: {title(entry.authorization.presentation)}</Chip>
										) : null}
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
									<details className="group mt-4 overflow-hidden rounded-lg border">
										<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
											<span className="font-medium">Decision Details</span>
											<span className="flex items-center gap-2 text-xs text-muted-foreground">
												{entry.authorization.trace.length}{' '}
												{entry.authorization.trace.length === 1 ? 'step' : 'steps'}
												<ChevronDown
													aria-hidden="true"
													className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none"
												/>
											</span>
										</summary>
										<ol className="flex flex-col gap-2 border-t p-3" aria-label="Decision trace">
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
														<CircleDashed
															aria-hidden="true"
															className="mt-0.5 size-4 shrink-0 text-muted-foreground"
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
																	Structured Evidence
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
									</details>
								</section>
							) : entry.login?.outcome === 'deny' ? (
								<p className="rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
									Authorization was skipped because the login policy denied this subject.
								</p>
							) : null}

							{entry.errors.length > 0 ? (
								<div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
									<p className="font-medium">The analyzer could not complete this scenario.</p>
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

function AnalyzerCapabilities({ metadata }: { metadata: PolicyAnalyzerMetadata }) {
	return (
		<div className="mb-6 flex flex-wrap gap-2" aria-label="Analyzer capabilities">
			<Chip>
				Login Policy: {metadata.capabilities.login_policy ? 'Available' : 'Not Configured'}
			</Chip>
			<Chip>
				Resource Labels: {metadata.capabilities.resource_security ? 'Available' : 'Not Configured'}
			</Chip>
		</div>
	);
}

interface SubjectStepProps {
	metadata: PolicyAnalyzerMetadata;
	users: readonly AdminUser[];
	selectedUserId: string;
	subjectId: string;
	subjectEmail: string;
	caseName: string;
	entitlements: Entitlement[];
	loginEnabled: boolean;
	expectedLoginOutcome: LoginOutcome;
	idClaims: string;
	userInfoClaims: string;
	onSelectUser: (id: string) => void;
	onSubjectIdChange: (value: string) => void;
	onSubjectEmailChange: (value: string) => void;
	onCaseNameChange: (value: string) => void;
	setEntitlements: Dispatch<SetStateAction<Entitlement[]>>;
	onLoginEnabledChange: (value: boolean) => void;
	onExpectedLoginOutcomeChange: (value: LoginOutcome) => void;
	onIdClaimsChange: (value: string) => void;
	onUserInfoClaimsChange: (value: string) => void;
}

function SubjectStep({
	metadata,
	users,
	selectedUserId,
	subjectId,
	subjectEmail,
	caseName,
	entitlements,
	loginEnabled,
	expectedLoginOutcome,
	idClaims,
	userInfoClaims,
	onSelectUser,
	onSubjectIdChange,
	onSubjectEmailChange,
	onCaseNameChange,
	setEntitlements,
	onLoginEnabledChange,
	onExpectedLoginOutcomeChange,
	onIdClaimsChange,
	onUserInfoClaimsChange,
}: SubjectStepProps) {
	const selectedEntitlements = useMemo(() => new Set(entitlements), [entitlements]);
	const knownUser = users.some((entry) => entry.id === selectedUserId);
	return (
		<StepCard
			number={1}
			title="Who Is Requesting Access?"
			description="Select a user or enter a test identity."
		>
			<div className="grid gap-3">
				<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
					User
					<select
						name="known-user"
						autoComplete="off"
						className={inputClass}
						value={knownUser ? selectedUserId : ''}
						onChange={(event) => onSelectUser(event.target.value)}
					>
						<option value="">Test identity</option>
						{users.map((entry) => (
							<option key={entry.id} value={entry.id}>
								{entry.name} · {entry.email}
							</option>
						))}
					</select>
				</label>
				{!knownUser ? (
					<div className="grid gap-3 sm:grid-cols-2">
						<TextField label="Subject ID" value={subjectId} onChange={onSubjectIdChange} />
						<TextField label="Subject Email" value={subjectEmail} onChange={onSubjectEmailChange} />
					</div>
				) : null}
			</div>

			<AdvancedSection
				title="Subject Options"
				summary={`${entitlements.length} ${entitlements.length === 1 ? 'entitlement' : 'entitlements'}`}
			>
				<TextField label="Scenario Name" value={caseName} onChange={onCaseNameChange} />
				<div className="mt-4 border-t pt-4">
					<p className="text-xs font-medium text-muted-foreground">Entitlements</p>
					<p className="mt-1 text-xs text-muted-foreground">
						{loginEnabled
							? 'Select the entitlements that the login policy must return.'
							: 'Select the entitlements that this identity has.'}
					</p>
					{metadata.entitlements.length > 0 ? (
						<div className="mt-2 grid gap-2 sm:grid-cols-2">
							{metadata.entitlements.map((entitlement) => (
								<label
									key={entitlement}
									className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted/50"
								>
									<input
										type="checkbox"
										aria-label={entitlement}
										checked={selectedEntitlements.has(entitlement)}
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
					) : (
						<p className="mt-2 text-sm text-muted-foreground">No entitlements are configured.</p>
					)}
				</div>
			</AdvancedSection>

			{metadata.capabilities.login_policy ? (
				<AdvancedSection
					title="Login Policy"
					summary={loginEnabled ? `Expected ${title(expectedLoginOutcome)}` : 'Not included'}
				>
					<label aria-label="Evaluate the login policy" className="flex items-start gap-3 text-sm">
						<input
							type="checkbox"
							aria-label="Evaluate the login policy"
							className="mt-1"
							checked={loginEnabled}
							onChange={(event) => onLoginEnabledChange(event.target.checked)}
						/>
						<span>
							<span className="font-medium">Include the Login Policy</span>
							<span className="mt-0.5 block text-xs text-muted-foreground">
								Provide test claims before the authorization check.
							</span>
						</span>
					</label>
					{loginEnabled ? (
						<div className="mt-4 grid gap-3 border-t pt-4 sm:grid-cols-2">
							<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
								Expected Decision
								<select
									name="expected-login-decision"
									autoComplete="off"
									className={inputClass}
									value={expectedLoginOutcome}
									onChange={(event) =>
										onExpectedLoginOutcomeChange(event.target.value as LoginOutcome)
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
									onChange={(event) => onIdClaimsChange(event.target.value)}
								/>
							</label>
							<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
								<span>
									UserInfo Claims <span className="font-normal">(Optional)</span>
								</span>
								<textarea
									aria-label="UserInfo claims"
									name="userinfo-claims"
									autoComplete="off"
									spellCheck={false}
									className={textAreaClass}
									rows={4}
									placeholder={'{\n  "department": "analytics"\n}'}
									value={userInfoClaims}
									onChange={(event) => onUserInfoClaimsChange(event.target.value)}
								/>
							</label>
						</div>
					) : null}
				</AdvancedSection>
			) : null}
		</StepCard>
	);
}

interface ResourceStepProps {
	metadata: PolicyAnalyzerMetadata;
	projects: readonly Pick<ProjectSummary, 'id' | 'name'>[];
	action: Action;
	actionRule: ActionRule | undefined;
	scope: Scope;
	source: ResourceSource;
	projectId: string;
	notebookId: string;
	sessionId: string;
	relationship: Relationship;
	memberRole: MemberRole;
	sessionMode: SessionMode;
	projectStatus: ProjectStatus;
	requiredClassification: string;
	requiredCompartments: string;
	onActionChange: (value: Action) => void;
	onSourceChange: (value: ResourceSource) => void;
	onProjectIdChange: (value: string) => void;
	onNotebookIdChange: (value: string) => void;
	onSessionIdChange: (value: string) => void;
	onRelationshipChange: (value: Relationship) => void;
	onMemberRoleChange: (value: MemberRole) => void;
	onSessionModeChange: (value: SessionMode) => void;
	onProjectStatusChange: (value: ProjectStatus) => void;
	onRequiredClassificationChange: (value: string) => void;
	onRequiredCompartmentsChange: (value: string) => void;
}

function ResourceStep({
	metadata,
	projects,
	action,
	actionRule,
	scope,
	source,
	projectId,
	notebookId,
	sessionId,
	relationship,
	memberRole,
	sessionMode,
	projectStatus,
	requiredClassification,
	requiredCompartments,
	onActionChange,
	onSourceChange,
	onProjectIdChange,
	onNotebookIdChange,
	onSessionIdChange,
	onRelationshipChange,
	onMemberRoleChange,
	onSessionModeChange,
	onProjectStatusChange,
	onRequiredClassificationChange,
	onRequiredCompartmentsChange,
}: ResourceStepProps) {
	return (
		<StepCard
			number={2}
			title="What Are They Trying to Do?"
			description="Choose an action and the resource that it applies to."
		>
			<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
				Action
				<select
					name="authorization-action"
					autoComplete="off"
					translate="no"
					className={inputClass}
					value={action}
					onChange={(event) => onActionChange(event.target.value as Action)}
				>
					{metadata.actions.map((entry) => (
						<option key={entry.action} value={entry.action}>
							{entry.action}
						</option>
					))}
				</select>
			</label>
			<p className="mt-2 text-xs text-muted-foreground">
				Rule: {title(scope)} scope
				{actionRule?.minimum_role ? ` · ${title(actionRule.minimum_role)} role or higher` : ''}
				{actionRule?.requires_super_admin ? ' · Super admin required' : ''}
				{actionRule?.denied_as ? ` · Denial: ${title(actionRule.denied_as)}` : ''}
			</p>

			{scope !== 'deployment' ? (
				<>
					<fieldset className="mt-4">
						<legend className="text-xs font-medium text-muted-foreground">Resource</legend>
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
										aria-label={value === 'synthetic' ? 'Test resource' : 'Existing resource'}
										name="resource-source"
										checked={source === value}
										onChange={() => onSourceChange(value)}
									/>
									{value === 'synthetic' ? 'Test Resource' : 'Existing Resource'}
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
									onChange={(event) => onProjectIdChange(event.target.value)}
								>
									<option value="">Select a project…</option>
									{projects.map((project) => (
										<option key={project.id} value={project.id}>
											{project.name}
										</option>
									))}
								</select>
							</label>
							<TextField
								label="Notebook ID (Optional)"
								value={notebookId}
								onChange={onNotebookIdChange}
							/>
							{scope === 'session' ? (
								<TextField label="Session ID" value={sessionId} onChange={onSessionIdChange} />
							) : null}
						</div>
					) : (
						<div className="mt-4 grid gap-3 sm:grid-cols-2">
							<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
								Project Relationship
								<select
									name="subject-relationship"
									autoComplete="off"
									className={inputClass}
									value={relationship}
									onChange={(event) => onRelationshipChange(event.target.value as Relationship)}
								>
									<option value="owner">Owner</option>
									<option value="member">Member</option>
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
										onChange={(event) => onMemberRoleChange(event.target.value as MemberRole)}
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
								onChange={(event) => onSessionModeChange(event.target.value as SessionMode)}
							>
								<option value="edit">Edit</option>
								<option value="app">App</option>
							</select>
						</label>
					) : null}

					{source === 'synthetic' ? (
						<AdvancedSection
							title="Resource Options"
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
										onChange={(event) => onProjectStatusChange(event.target.value as ProjectStatus)}
									>
										<option value="active">Active</option>
										<option value="deleted">Deleted</option>
									</select>
								</label>
								<TextField
									label="Required Classification"
									placeholder={`${metadata.classification_order[0] ?? 'LEVEL_1'}…`}
									value={requiredClassification}
									onChange={onRequiredClassificationChange}
								/>
								<TextField
									label="Required Compartments"
									placeholder="team-a, project-b…"
									value={requiredCompartments}
									onChange={onRequiredCompartmentsChange}
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
					This action applies to the deployment. It does not require a project or session.
				</p>
			)}
		</StepCard>
	);
}

interface ExpectedResultStepProps {
	metadata: PolicyAnalyzerMetadata;
	expectedAllowed: boolean;
	expectedDenialCategory: DenialCategory | '';
	loginEnabled: boolean;
	expectedLoginOutcome: LoginOutcome;
	contextMode: ContextMode;
	heldClassification: string;
	heldCompartments: string;
	onExpectedAllowedChange: (value: boolean) => void;
	onExpectedDenialCategoryChange: (value: DenialCategory | '') => void;
	onContextModeChange: (value: ContextMode) => void;
	onHeldClassificationChange: (value: string) => void;
	onHeldCompartmentsChange: (value: string) => void;
}

function ExpectedResultStep({
	metadata,
	expectedAllowed,
	expectedDenialCategory,
	loginEnabled,
	expectedLoginOutcome,
	contextMode,
	heldClassification,
	heldCompartments,
	onExpectedAllowedChange,
	onExpectedDenialCategoryChange,
	onContextModeChange,
	onHeldClassificationChange,
	onHeldCompartmentsChange,
}: ExpectedResultStepProps) {
	return (
		<StepCard
			number={3}
			title="What Result Do You Expect?"
			description="The scenario passes when the analyzer returns this result."
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
					Expected Decision
					<select
						name="expected-authorization-decision"
						autoComplete="off"
						className={inputClass}
						value={expectedAllowed ? 'allow' : 'deny'}
						onChange={(event) => onExpectedAllowedChange(event.target.value === 'allow')}
					>
						<option value="allow">Allow</option>
						<option value="deny">Deny</option>
					</select>
				</label>
				{!expectedAllowed ? (
					<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
						<span>
							Expected Denial Category <span className="font-normal">(Optional)</span>
						</span>
						<select
							name="expected-denial-category"
							autoComplete="off"
							className={inputClass}
							value={expectedDenialCategory}
							onChange={(event) =>
								onExpectedDenialCategoryChange(event.target.value as DenialCategory | '')
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
						A denied login skips authorization. The authorization expectation applies only if the
						login policy unexpectedly allows this subject.
					</p>
				</div>
			) : null}

			{metadata.capabilities.resource_security ? (
				<AdvancedSection
					title="Security Context"
					summary={contextMode === 'live-self' ? 'Live self' : heldClassification || 'None'}
				>
					<p className="mb-3 text-xs text-muted-foreground">
						Set the subject classification and compartments for resource-label checks.
					</p>
					<div className="grid gap-3 sm:grid-cols-2">
						<label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
							Context Source
							<select
								name="context-source"
								autoComplete="off"
								className={inputClass}
								value={contextMode}
								onChange={(event) => onContextModeChange(event.target.value as ContextMode)}
							>
								<option value="synthetic">Test Context</option>
								<option value="live-self" disabled={!metadata.capabilities.live_self_context}>
									Current Context for Signed-In Admin
								</option>
							</select>
						</label>
						{contextMode === 'synthetic' ? (
							<>
								<TextField
									label="Subject Classification"
									placeholder={`${metadata.classification_order.at(-1) ?? 'LEVEL_3'}…`}
									value={heldClassification}
									onChange={onHeldClassificationChange}
								/>
								<TextField
									label="Subject Compartments"
									placeholder="team-a, project-b…"
									value={heldCompartments}
									onChange={onHeldCompartmentsChange}
								/>
							</>
						) : (
							<p className="self-end text-xs text-muted-foreground">
								The analyzer uses the security context of the signed-in admin.
							</p>
						)}
					</div>
				</AdvancedSection>
			) : null}
		</StepCard>
	);
}

interface ScenarioSummaryProps {
	subjectEmail: string;
	action: Action;
	scope: Scope;
	source: ResourceSource;
	expectedAllowed: boolean;
	loginEnabled: boolean;
	expectedLoginOutcome: LoginOutcome;
	isPending: boolean;
	onRun: () => void;
	onAddToSuite: () => void;
}

function ScenarioSummary({
	subjectEmail,
	action,
	scope,
	source,
	expectedAllowed,
	loginEnabled,
	expectedLoginOutcome,
	isPending,
	onRun,
	onAddToSuite,
}: ScenarioSummaryProps) {
	return (
		<aside className="min-w-0 self-start rounded-xl border bg-card p-4 shadow-xs xl:sticky xl:top-4">
			<h2 className="font-semibold">Scenario</h2>
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
							{scope === 'deployment' ? 'Deployment' : source === 'stored' ? 'Existing' : 'Test'}
						</dd>
					</div>
					<div>
						<dt className="text-xs text-muted-foreground">Expected</dt>
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

			<div className="mt-5 flex flex-col gap-2 border-t pt-4">
				<Button variant="primary" onPress={onRun} isDisabled={isPending} className="w-full">
					<Play aria-hidden="true" className="size-4" />
					{isPending ? 'Running…' : 'Run Scenario'}
				</Button>
				<Button onPress={onAddToSuite} isDisabled={isPending} className="w-full">
					<Plus aria-hidden="true" className="size-4" /> Add to Suite
				</Button>
			</div>
		</aside>
	);
}

function AnalyzerMessages({
	formError,
	requestError,
	suiteNotice,
	errorRef,
}: {
	formError: string | null;
	requestError: Error | null;
	suiteNotice: string | null;
	errorRef: RefObject<HTMLDivElement | null>;
}) {
	return (
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
			{requestError ? (
				<div
					role="alert"
					className="mt-5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive"
				>
					<p className="font-medium">The analyzer request failed.</p>
					<p>{requestError.message}</p>
				</div>
			) : null}
			{suiteNotice ? (
				<p className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">{suiteNotice}</p>
			) : null}
		</div>
	);
}

interface SuiteEditorProps {
	suiteInfo: SuiteInfo;
	maximumCases: number;
	suiteText: string;
	isPending: boolean;
	fileInput: RefObject<HTMLInputElement | null>;
	onSuiteTextChange: (value: string) => void;
	onSuiteNoticeChange: (value: string | null) => void;
	onError: (error: unknown, fallback: string) => void;
	onRun: () => void;
}

function SuiteEditor({
	suiteInfo,
	maximumCases,
	suiteText,
	isPending,
	fileInput,
	onSuiteTextChange,
	onSuiteNoticeChange,
	onError,
	onRun,
}: SuiteEditorProps) {
	return (
		<details className="group mt-8 overflow-hidden rounded-xl border bg-card">
			<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
				<div className="flex min-w-0 items-center gap-3">
					<FileJson aria-hidden="true" className="size-5 shrink-0 text-primary" />
					<div className="min-w-0">
						<h2 className="font-semibold">JSON Suite</h2>
						<p className="text-xs text-muted-foreground">
							{suiteInfo.valid
								? `${suiteInfo.count} of ${maximumCases} scenarios · Version 1`
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
						Import, edit, or export multiple scenarios in the version 1 JSON format.
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
									assertSuiteLimit(suite, maximumCases);
									onSuiteTextChange(value);
									onSuiteNoticeChange(`Imported ${file.name}.`);
								})
								.catch((error: unknown) => onError(error, 'The suite file could not be read.'));
						}
						event.target.value = '';
					}}
				/>
				<div className="mt-4 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
					<AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
					JSON suites can include sample claims and security context. Treat exported files as
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
						onSuiteTextChange(event.target.value);
						onSuiteNoticeChange(null);
					}}
				/>
				<div className="mt-3 flex flex-wrap items-center justify-between gap-3">
					<p
						className={`text-xs ${suiteInfo.valid ? 'text-muted-foreground' : 'text-destructive'}`}
					>
						{suiteInfo.valid ? `${suiteInfo.count} scenarios ready` : suiteInfo.message}
					</p>
					<Button variant="primary" onPress={onRun} isDisabled={isPending || !suiteInfo.valid}>
						<FileJson aria-hidden="true" className="size-4" />
						{isPending
							? 'Running…'
							: `Run Suite (${suiteInfo.count} ${suiteInfo.count === 1 ? 'Scenario' : 'Scenarios'})`}
					</Button>
				</div>
			</div>
		</details>
	);
}

interface BuildPolicyCaseInput {
	caseName: string;
	subjectId: string;
	subjectEmail: string;
	scope: Scope;
	source: ResourceSource;
	projectId: string;
	notebookId: string;
	sessionId: string;
	sessionMode: SessionMode;
	relationship: Relationship;
	memberRole: MemberRole;
	projectStatus: ProjectStatus;
	requiredClassification: string;
	requiredCompartments: string;
	loginEnabled: boolean;
	expectedLoginOutcome: LoginOutcome;
	entitlements: Entitlement[];
	idClaims: string;
	userInfoClaims: string;
	action: Action;
	contextMode: ContextMode;
	heldClassification: string;
	heldCompartments: string;
	expectedAllowed: boolean;
	expectedDenialCategory: DenialCategory | '';
}

function buildPolicyCase(input: BuildPolicyCaseInput): PolicyCase {
	if (!input.caseName.trim()) throw new Error('Enter a scenario name.');
	if (!input.subjectId.trim()) throw new Error('Enter a subject ID.');
	if (!input.subjectEmail.trim()) throw new Error('Enter a subject email.');
	if (input.scope !== 'deployment' && input.source === 'stored' && !input.projectId) {
		throw new Error('Select an existing project, or use a test resource.');
	}
	if (input.scope === 'session' && input.source === 'stored' && !input.sessionId.trim()) {
		throw new Error('Enter the stored session ID.');
	}
	const labels = input.requiredClassification
		? {
				classification: input.requiredClassification,
				compartments: list(input.requiredCompartments),
			}
		: undefined;
	const resource: NonNullable<PolicyCase['authorization']>['resource'] =
		input.scope === 'deployment'
			? { source: 'synthetic', kind: 'deployment' }
			: input.source === 'stored'
				? {
						source: input.source,
						kind: input.scope,
						project_id: input.projectId,
						...(input.notebookId.trim() ? { notebook_id: input.notebookId.trim() } : {}),
						...(input.sessionId.trim() ? { session_id: input.sessionId.trim() } : {}),
						...(input.scope === 'session-start' ? { mode: input.sessionMode } : {}),
					}
				: {
						source: input.source,
						kind: input.scope,
						project: {
							owner: input.relationship === 'owner' ? input.subjectId.trim() : 'policy-owner',
							members:
								input.relationship === 'member'
									? [{ user_id: input.subjectId.trim(), role: input.memberRole }]
									: [],
							status: input.projectStatus,
							...(labels ? { security_labels: labels } : {}),
						},
						...(input.scope === 'session'
							? { session: { mode: input.sessionMode, user_id: input.subjectId.trim() } }
							: {}),
						...(input.scope === 'session-start' ? { mode: input.sessionMode } : {}),
					};
	return {
		id: `case-${Date.now()}`,
		name: input.caseName.trim(),
		...(input.loginEnabled
			? {
					login: {
						identity: { id: input.subjectId.trim(), email: input.subjectEmail.trim() },
						id_token_claims: parseObject(input.idClaims, 'ID-token claims'),
						...(input.userInfoClaims.trim()
							? {
									user_info_claims: parseObject(input.userInfoClaims, 'UserInfo claims'),
								}
							: {}),
						expected: {
							outcome: input.expectedLoginOutcome,
							...(input.expectedLoginOutcome === 'allow'
								? { entitlements: input.entitlements }
								: {}),
						},
					},
				}
			: {}),
		authorization: {
			subject: {
				id: input.subjectId.trim(),
				email: input.subjectEmail.trim(),
				entitlement_source: input.loginEnabled ? 'login' : 'explicit',
				...(!input.loginEnabled ? { entitlements: input.entitlements } : {}),
			},
			action: input.action,
			resource,
			context:
				input.contextMode === 'live-self'
					? { mode: 'live-self' }
					: {
							mode: 'synthetic',
							value: input.heldClassification
								? {
										schemaVersion: 1,
										classification: input.heldClassification,
										compartments: list(input.heldCompartments),
										policyVersion: 'policy-analyzer',
										expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
									}
								: null,
						},
			expected: {
				allowed: input.expectedAllowed,
				...(!input.expectedAllowed && input.expectedDenialCategory
					? { denial_category: input.expectedDenialCategory }
					: {}),
			},
		},
	};
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
	const [selectedUserId, setSelectedUserId] = useState(firstUser?.id ?? '');
	const [testSubjectId, setTestSubjectId] = useState('test-user');
	const [testSubjectEmail, setTestSubjectEmail] = useState('test@example.com');
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
	const selectedUser = users.find((entry) => entry.id === selectedUserId);
	const subjectId = selectedUser?.id ?? testSubjectId;
	const subjectEmail = selectedUser?.email ?? testSubjectEmail;

	const actionRule = useMemo(
		() => metadata.actions.find((entry) => entry.action === action),
		[action, metadata.actions],
	);
	const scope = actionRule?.scope ?? 'project';
	const suiteInfo = useMemo<SuiteInfo>(() => {
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
		setSelectedUserId(id);
	}

	function reportError(error: unknown, fallback: string) {
		setFormError(error instanceof Error ? error.message : fallback);
		requestAnimationFrame(() => errorRef.current?.focus());
	}

	function buildCase(): PolicyCase {
		return buildPolicyCase({
			caseName,
			subjectId,
			subjectEmail,
			scope,
			source,
			projectId,
			notebookId,
			sessionId,
			sessionMode,
			relationship,
			memberRole,
			projectStatus,
			requiredClassification,
			requiredCompartments,
			loginEnabled,
			expectedLoginOutcome,
			entitlements,
			idClaims,
			userInfoClaims,
			action,
			contextMode,
			heldClassification,
			heldCompartments,
			expectedAllowed,
			expectedDenialCategory,
		});
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
				throw new Error(`A suite can contain at most ${metadata.max_cases} scenarios.`);
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
						Build a scenario to see whether the current policy allows or denies an action. The
						analyzer does not change access.
					</p>
				</div>
			</PageHeader>

			<AnalyzerCapabilities metadata={metadata} />

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
				<main className="flex min-w-0 flex-col gap-5">
					<SubjectStep
						metadata={metadata}
						users={users}
						selectedUserId={selectedUserId}
						subjectId={subjectId}
						subjectEmail={subjectEmail}
						caseName={caseName}
						entitlements={entitlements}
						loginEnabled={loginEnabled}
						expectedLoginOutcome={expectedLoginOutcome}
						idClaims={idClaims}
						userInfoClaims={userInfoClaims}
						onSelectUser={selectUser}
						onSubjectIdChange={setTestSubjectId}
						onSubjectEmailChange={setTestSubjectEmail}
						onCaseNameChange={setCaseName}
						setEntitlements={setEntitlements}
						onLoginEnabledChange={setLoginEnabled}
						onExpectedLoginOutcomeChange={setExpectedLoginOutcome}
						onIdClaimsChange={setIdClaims}
						onUserInfoClaimsChange={setUserInfoClaims}
					/>
					<ResourceStep
						metadata={metadata}
						projects={projects.data ?? []}
						action={action}
						actionRule={actionRule}
						scope={scope}
						source={source}
						projectId={projectId}
						notebookId={notebookId}
						sessionId={sessionId}
						relationship={relationship}
						memberRole={memberRole}
						sessionMode={sessionMode}
						projectStatus={projectStatus}
						requiredClassification={requiredClassification}
						requiredCompartments={requiredCompartments}
						onActionChange={setAction}
						onSourceChange={setSource}
						onProjectIdChange={setProjectId}
						onNotebookIdChange={setNotebookId}
						onSessionIdChange={setSessionId}
						onRelationshipChange={setRelationship}
						onMemberRoleChange={setMemberRole}
						onSessionModeChange={setSessionMode}
						onProjectStatusChange={setProjectStatus}
						onRequiredClassificationChange={setRequiredClassification}
						onRequiredCompartmentsChange={setRequiredCompartments}
					/>
					<ExpectedResultStep
						metadata={metadata}
						expectedAllowed={expectedAllowed}
						expectedDenialCategory={expectedDenialCategory}
						loginEnabled={loginEnabled}
						expectedLoginOutcome={expectedLoginOutcome}
						contextMode={contextMode}
						heldClassification={heldClassification}
						heldCompartments={heldCompartments}
						onExpectedAllowedChange={setExpectedAllowed}
						onExpectedDenialCategoryChange={setExpectedDenialCategory}
						onContextModeChange={setContextMode}
						onHeldClassificationChange={setHeldClassification}
						onHeldCompartmentsChange={setHeldCompartments}
					/>
				</main>
				<ScenarioSummary
					subjectEmail={subjectEmail}
					action={action}
					scope={scope}
					source={source}
					expectedAllowed={expectedAllowed}
					loginEnabled={loginEnabled}
					expectedLoginOutcome={expectedLoginOutcome}
					isPending={run.isPending}
					onRun={runOne}
					onAddToSuite={addToSuite}
				/>
			</div>

			<AnalyzerMessages
				formError={formError}
				requestError={run.error}
				suiteNotice={suiteNotice}
				errorRef={errorRef}
			/>

			{run.data ? <ResultCard result={run.data} /> : null}

			<SuiteEditor
				suiteInfo={suiteInfo}
				maximumCases={metadata.max_cases}
				suiteText={suiteText}
				isPending={run.isPending}
				fileInput={fileInput}
				onSuiteTextChange={setSuiteText}
				onSuiteNoticeChange={setSuiteNotice}
				onError={reportError}
				onRun={runSuite}
			/>
		</PageContainer>
	);
}
