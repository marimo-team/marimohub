import type { IntegrationConfigMap } from './generated';

export type { IntegrationConfigMap } from './generated';
export type IntegrationKind = keyof IntegrationConfigMap;
export type ConfigFor<K extends IntegrationKind> = IntegrationConfigMap[K];
interface IntegrationOptions {
	readonly enabled?: boolean;
	readonly change_note?: string;
}
export type IntegrationSpec = {
	[K in IntegrationKind]: Readonly<{
		kind: K;
		name: string;
		config: ConfigFor<K>;
	}> &
		IntegrationOptions;
}[IntegrationKind];
const customKind = Symbol('customIntegration');
export interface CustomIntegrationSpec extends IntegrationOptions {
	readonly [customKind]: true;
	readonly kind: string;
	readonly name: string;
	readonly config: Readonly<Record<string, unknown>>;
}
export type Declaration = IntegrationSpec | CustomIntegrationSpec;
export type Mode = 'insert' | 'ensure' | 'upsert';
export interface ReconcileOptions {
	mode?: Mode;
	allowOrgOverride?: boolean;
	signal?: AbortSignal;
}
export interface HubOptions {
	url: string;
	token: string | (() => string | Promise<string>);
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	maxAttempts?: number;
}
export type Precondition =
	| { state: 'absent' }
	| { state: 'existing'; id: string; revision: string };
export interface PlannedIntegration {
	name: string;
	kind: string;
	action: 'create' | 'update' | 'unchanged';
	changed_paths: readonly string[];
	precondition: Precondition;
	org_override: boolean;
}
export interface IntegrationOutcome {
	name: string;
	kind: string;
	id: string;
	action: 'created' | 'updated' | 'unchanged' | 'converged';
	current_version: number;
	config_changed: boolean;
}
export interface BatchReport {
	completed: readonly IntegrationOutcome[];
	failed?: { name: string; kind: string; code: string; uncertain: boolean };
	notAttempted: readonly { name: string; kind: string }[];
}

export class IacError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status?: number,
		readonly uncertain = false,
		readonly retryAfterMs?: number,
		readonly requestId?: string,
	) {
		super(message);
		this.name = 'IacError';
	}
}
export class ApplyError extends IacError {
	constructor(
		readonly report: BatchReport,
		error: IacError,
	) {
		super(
			error.code,
			error.message,
			error.status,
			error.uncertain,
			error.retryAfterMs,
			error.requestId,
		);
		this.name = 'ApplyError';
	}
}

function freeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const nested of Object.values(value)) freeze(nested);
		Object.freeze(value);
	}
	return value;
}

function define<K extends IntegrationKind>(
	kind: K,
	name: string,
	config: ConfigFor<NoInfer<K>>,
	options: IntegrationOptions = {},
) {
	return freeze(structuredClone({ kind, name, config, ...options }));
}
export const integration = Object.assign(define, {
	custom<T extends Record<string, unknown>>(
		kind: string,
		name: string,
		config: T,
		validate: (config: T) => void,
		options: IntegrationOptions = {},
	): CustomIntegrationSpec {
		try {
			validate(config);
		} catch {
			throw new IacError('VALIDATION_ERROR', 'Custom integration validation failed.');
		}
		return freeze({ ...structuredClone({ kind, name, config, ...options }), [customKind]: true });
	},
});
export const secret = {
	ref: (backend: string, locator: string) =>
		freeze({ $secret: { kind: 'reference' as const, backend, locator } }),
	keep: () => freeze({ $secret: { kind: 'managed' as const, set: true as const } }),
};

interface PlanState {
	owner: object;
	desired: readonly Record<string, unknown>[];
}
const planStates = new WeakMap<IntegrationPlan, PlanState>();
export class IntegrationPlan {
	constructor(readonly items: readonly PlannedIntegration[]) {
		freeze(items);
	}
	summary(): string {
		return this.items
			.map(
				(item) =>
					`${item.action}: ${item.kind}/${item.name}${item.org_override ? ' (organization override)' : ''}`,
			)
			.join('\n');
	}
	toJSON() {
		return { items: this.items };
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isPlan(value: unknown): value is PlannedIntegration {
	return (
		record(value) &&
		typeof value.name === 'string' &&
		typeof value.kind === 'string' &&
		typeof value.action === 'string' &&
		['create', 'update', 'unchanged'].includes(value.action) &&
		Array.isArray(value.changed_paths) &&
		value.changed_paths.every((path) => typeof path === 'string') &&
		typeof value.org_override === 'boolean' &&
		record(value.precondition) &&
		(value.precondition.state === 'absent' ||
			(value.precondition.state === 'existing' &&
				typeof value.precondition.id === 'string' &&
				typeof value.precondition.revision === 'string'))
	);
}
function isOutcome(value: unknown): value is IntegrationOutcome {
	return (
		record(value) &&
		typeof value.name === 'string' &&
		typeof value.kind === 'string' &&
		typeof value.id === 'string' &&
		typeof value.action === 'string' &&
		['created', 'updated', 'unchanged'].includes(value.action) &&
		typeof value.current_version === 'number' &&
		Number.isSafeInteger(value.current_version) &&
		value.current_version >= 1 &&
		typeof value.config_changed === 'boolean'
	);
}
function parsePlan(value: unknown): PlannedIntegration | undefined {
	if (!isPlan(value)) return undefined;
	const { name, kind, action, changed_paths, org_override, precondition } = value;
	return {
		name,
		kind,
		action,
		changed_paths,
		org_override,
		precondition:
			precondition.state === 'absent'
				? { state: 'absent' }
				: { state: 'existing', id: precondition.id, revision: precondition.revision },
	};
}
function parseOutcome(value: unknown): IntegrationOutcome | undefined {
	if (!isOutcome(value)) return undefined;
	const { name, kind, id, action, current_version, config_changed } = value;
	return { name, kind, id, action, current_version, config_changed };
}
function errorFor(error: unknown, uncertain = false): IacError {
	if (error instanceof IacError) {
		if (!uncertain || error.uncertain) return error;
		const failure = new IacError(
			error.code,
			error.message,
			error.status,
			true,
			error.retryAfterMs,
			error.requestId,
		);
		return error instanceof ApplyError
			? new ApplyError(
					{
						...error.report,
						failed: error.report.failed && { ...error.report.failed, uncertain: true },
					},
					failure,
				)
			: failure;
	}
	return new IacError(
		'NETWORK_ERROR',
		'Hub request failed. Check connectivity and credentials.',
		undefined,
		uncertain,
	);
}
const httpErrors: Partial<Record<number, { code: string; message: string }>> = {
	401: {
		code: 'UNAUTHORIZED',
		message: 'Hub credentials are invalid or expired. Supply a current token.',
	},
	403: {
		code: 'FORBIDDEN',
		message: 'The token or identity lacks integration.manage for this project.',
	},
	404: {
		code: 'NOT_FOUND',
		message: 'Project or reconciliation API not found. Check the project ID and Hub version.',
	},
	409: {
		code: 'CONFLICT',
		message:
			'Integration name conflicts with another kind, an inherited integration, or a concurrent writer. Review the name and override policy.',
	},
	412: {
		code: 'PRECONDITION_FAILED',
		message: 'Integration changed after planning. Create and review a new plan.',
	},
	422: {
		code: 'VALIDATION_ERROR',
		message:
			'Integration declaration is invalid. Check required fields, secret backends, and deployment secret policy.',
	},
	429: {
		code: 'HTTP_ERROR',
		message: 'Hub request limit reached. Retry after the indicated delay.',
	},
};
const maxTimerMs = 2 ** 31 - 1;
function retryDelay(value: string | null): number | undefined {
	if (!value) return undefined;
	const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
	return Number.isNaN(milliseconds) ? undefined : Math.min(maxTimerMs, Math.max(0, milliseconds));
}

export function createHub(options: HubOptions) {
	let base: URL;
	try {
		base = new URL(options.url);
	} catch {
		throw new IacError('VALIDATION_ERROR', 'Hub URL is invalid.');
	}
	if (
		!['http:', 'https:'].includes(base.protocol) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	) {
		throw new IacError(
			'VALIDATION_ERROR',
			'Hub URL must be an HTTP(S) URL without credentials, query, or fragment.',
		);
	}
	base.pathname = `${base.pathname.replace(/\/$/, '')}/api/v1/`;
	const timeoutMs = options.timeoutMs ?? 20_000;
	const maxAttempts = options.maxAttempts ?? 3;
	if (
		!Number.isInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > maxTimerMs ||
		!Number.isInteger(maxAttempts) ||
		maxAttempts < 1 ||
		maxAttempts > 10
	) {
		throw new IacError(
			'VALIDATION_ERROR',
			'Use an integer timeout from 1 to 2147483647 milliseconds and between one and ten attempts.',
		);
	}
	const fetcher = options.fetch ?? globalThis.fetch;
	async function request<T>(
		path: string,
		body: unknown,
		signal: AbortSignal,
		parse: (value: unknown) => T | undefined,
		mutation = false,
	): Promise<T> {
		let token: string;
		try {
			signal.throwIfAborted();
			token = await new Promise<string>((resolve, reject) => {
				const cancel = () => reject(new IacError('ABORTED', 'Token acquisition was cancelled.'));
				signal.addEventListener('abort', cancel, { once: true });
				Promise.resolve()
					.then(() => (typeof options.token === 'string' ? options.token : options.token()))
					.then(resolve, reject)
					.finally(() => signal.removeEventListener('abort', cancel));
			});
		} catch {
			throw new IacError(
				signal.aborted ? 'ABORTED' : 'AUTH_ERROR',
				'Unable to obtain a Hub token.',
			);
		}
		if (!token) throw new IacError('AUTH_ERROR', 'Hub token is required.');
		let response: Response;
		try {
			signal.throwIfAborted();
			response = await fetcher(new URL(path, base), {
				method: 'POST',
				redirect: 'error',
				signal,
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
		} catch {
			throw new IacError(
				signal.aborted ? 'ABORTED' : 'NETWORK_ERROR',
				'Hub request did not complete. Reconcile before retrying a mutation.',
				undefined,
				mutation,
			);
		}
		if (!response.ok) {
			const retryAfterMs = retryDelay(response.headers.get('Retry-After'));
			const failure = httpErrors[response.status];
			const rawId = response.headers.get('X-Request-Id');
			const requestId = rawId && /^[a-zA-Z0-9_-]{1,128}$/.test(rawId) ? rawId : undefined;
			throw new IacError(
				failure?.code ?? 'HTTP_ERROR',
				failure?.message ??
					(response.status >= 500
						? 'Hub is unavailable. Check deployment health before retrying.'
						: `Hub rejected the request (${response.status}).`),
				response.status,
				mutation && response.status >= 500,
				retryAfterMs,
				requestId,
			);
		}
		try {
			const envelope: unknown = await response.json();
			if (record(envelope) && envelope.success === true) {
				const result = parse(envelope.data);
				if (result !== undefined) return result;
			}
		} catch {
			/* Intermediaries can return non-JSON responses. */
		}
		throw new IacError(
			'PARSE_ERROR',
			'Hub returned an invalid reconciliation response.',
			response.status,
			mutation,
		);
	}
	function deadline(signal?: AbortSignal) {
		return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
	}
	async function delay(error: IacError, attempt: number, signal: AbortSignal) {
		const milliseconds = error.retryAfterMs ?? 50 * 2 ** attempt;
		await new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(new IacError('ABORTED', 'Reconciliation deadline reached.'));
				return;
			}
			const cancel = () => {
				clearTimeout(timer);
				reject(new IacError('ABORTED', 'Reconciliation deadline reached.'));
			};
			const timer = setTimeout(() => {
				signal.removeEventListener('abort', cancel);
				resolve();
			}, milliseconds);
			signal.addEventListener('abort', cancel, { once: true });
		});
	}
	return {
		project(projectId: string) {
			const owner = {};
			const path = `projects/${encodeURIComponent(projectId)}/integrations/reconcile/`;
			async function plan(
				specs: readonly Declaration[],
				reconcile: ReconcileOptions = {},
			): Promise<IntegrationPlan> {
				const signal = deadline(reconcile.signal);
				const seen = new Set<string>();
				const desired = specs.map((spec) => {
					if (!/^[a-z][a-z0-9-]{0,31}$/.test(spec.name) || seen.has(spec.name))
						throw new IacError(
							'VALIDATION_ERROR',
							'Integration names must be valid and unique within a plan.',
						);
					seen.add(spec.name);
					return structuredClone({
						...spec,
						mode: reconcile.mode ?? 'upsert',
						allowOrgOverride: reconcile.allowOrgOverride ?? false,
					});
				});
				const items: PlannedIntegration[] = [];
				for (const item of desired) {
					for (let attempt = 0; ; attempt++) {
						try {
							items.push(await request(`${path}plan`, item, signal, parsePlan));
							break;
						} catch (error) {
							const failure = errorFor(error);
							if (
								attempt + 1 >= maxAttempts ||
								!(
									failure.code === 'NETWORK_ERROR' ||
									failure.status === 429 ||
									(failure.status ?? 0) >= 500
								)
							)
								throw failure;
							await delay(failure, attempt, signal);
						}
					}
				}
				const result = new IntegrationPlan(items);
				planStates.set(result, { owner, desired });
				return Object.freeze(result);
			}
			async function apply(
				plan: IntegrationPlan,
				reconcile: Pick<ReconcileOptions, 'signal'> = {},
			): Promise<BatchReport> {
				const state = planStates.get(plan);
				if (!state || state.owner !== owner)
					throw new IacError(
						'INVALID_PLAN',
						'Apply a plan created by this project scope in this process.',
					);
				const signal = deadline(reconcile.signal);
				const completed: IntegrationOutcome[] = [];
				for (const [index, desired] of state.desired.entries()) {
					try {
						completed.push(
							await request(
								`${path}apply`,
								{ desired, expected: plan.items[index].precondition },
								signal,
								parseOutcome,
								true,
							),
						);
					} catch (error) {
						const failure = errorFor(error);
						throw new ApplyError(
							{
								completed,
								failed: {
									name: plan.items[index].name,
									kind: plan.items[index].kind,
									code: failure.code,
									uncertain: failure.uncertain,
								},
								notAttempted: plan.items.slice(index + 1).map(({ name, kind }) => ({ name, kind })),
							},
							failure,
						);
					}
				}
				return { completed, notAttempted: [] };
			}
			async function reconcile(
				spec: Declaration,
				mode: Mode,
				settings: Omit<ReconcileOptions, 'mode'> = {},
			): Promise<IntegrationOutcome> {
				const signal = deadline(settings.signal);
				let uncertain = false;
				for (let attempt = 0; ; attempt++) {
					try {
						const current = await plan([spec], { ...settings, mode, signal });
						const result = (await apply(current, { signal })).completed[0];
						return uncertain ? { ...result, action: 'converged' } : result;
					} catch (error) {
						const currentFailure = errorFor(error);
						const failure = errorFor(currentFailure, uncertain);
						uncertain ||= failure.uncertain;
						if (
							mode === 'insert' ||
							attempt + 1 >= maxAttempts ||
							!(
								currentFailure.uncertain ||
								currentFailure.code === 'CONFLICT' ||
								currentFailure.code === 'PRECONDITION_FAILED'
							)
						)
							throw failure;
						try {
							await delay(failure, attempt, signal);
						} catch (error) {
							throw errorFor(error, uncertain);
						}
					}
				}
			}
			return {
				integrations: {
					plan,
					apply,
					upsert: (spec: Declaration, settings?: Omit<ReconcileOptions, 'mode'>) =>
						reconcile(spec, 'upsert', settings),
					insert: (spec: Declaration, settings?: Omit<ReconcileOptions, 'mode'>) =>
						reconcile(spec, 'insert', settings),
					ensure: (spec: Declaration, settings?: Omit<ReconcileOptions, 'mode'>) =>
						reconcile(spec, 'ensure', settings),
				},
			};
		},
	};
}
