import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunId, UnavailableError, ValidationError } from '@marimo-hub/core';
import type {
	JobDefinition,
	JobRun,
	Project,
	ProjectIntegrationsService,
	SessionRender,
} from '@marimo-hub/core';
import type { JobRunContext } from '@marimo-hub/core/jobs';
import { ACTOR, makeProject, uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { resolveFederatedVars, resolveIntegrationRender, resolveJobSandboxEnv } from './sandboxEnv';
import { createInitializedBucket, makeTestDeps } from './testing';
import type { ApiDeps } from './context';

const AUTHOR = uid('author-1');
const TRIGGERER = uid('triggerer-1');

function context(overrides: { project?: Project; run?: Partial<JobRun> } = {}): JobRunContext {
	const project = overrides.project ?? makeProject({ federation: { enabled: true } });
	const job = {
		id: 'job-0123456789abcdef',
		project_id: project.id,
		notebook_id: 'nb-0123456789abcdef',
		created_by: AUTHOR,
	} as unknown as JobDefinition;
	const run = {
		run_id: createRunId(),
		job_id: job.id,
		project_id: project.id,
		notebook_id: job.notebook_id,
		status: 'provisioning',
		trigger: 'schedule',
		...overrides.run,
	} as unknown as JobRun;
	return {
		run,
		job,
		project,
		notebook: {} as never,
		image: undefined,
		computeProfile: { name: undefined, resources: {} },
	};
}

function wif(exchange = vi.fn(async () => ({ accessKeyId: 'AK', secretAccessKey: 'SK' }))) {
	return {
		exchange,
		config: {
			issuer: { mint: vi.fn(async () => 'jwt'), jwks: async () => ({ keys: [] }) },
			issuerUrl: 'https://hub.example',
			target: {
				broker: { exchange },
				audience: 'aud',
				storage: { endpoint: 'https://s3.example', region: 'eu' },
			},
		} as unknown as ApiDeps['wif'],
	};
}

function integrations(render: SessionRender | (() => Promise<SessionRender | undefined>)) {
	const resolveForSession = vi.fn(
		typeof render === 'function' ? render : async () => render,
	) as unknown as ProjectIntegrationsService['resolveForSession'];
	return {
		service: { resolveForSession } as unknown as ProjectIntegrationsService,
		resolveForSession: resolveForSession as unknown as ReturnType<typeof vi.fn>,
	};
}

describe('resolveFederatedVars', () => {
	it('yields nothing without WIF, without a federation opt-in, or for a restricted sandbox', async () => {
		const federated = makeProject({ federation: { enabled: true } });
		const { config } = wif();
		expect(
			await resolveFederatedVars(
				{},
				{
					project: federated,
					workload: { kind: 'job-run', id: createRunId() },
					restricted: false,
				},
			),
		).toBeUndefined();
		expect(
			await resolveFederatedVars(
				{ wif: config },
				{
					project: makeProject(),
					workload: { kind: 'job-run', id: createRunId() },
					restricted: false,
				},
			),
		).toBeUndefined();
		expect(
			await resolveFederatedVars(
				{ wif: config },
				{
					project: federated,
					workload: { kind: 'job-run', id: createRunId() },
					restricted: true,
				},
			),
		).toBeUndefined();
	});

	it('maps exchanged credentials onto S3 env vars', async () => {
		const { config } = wif();
		expect(
			await resolveFederatedVars(
				{ wif: config },
				{
					project: makeProject({ federation: { enabled: true } }),
					workload: { kind: 'job-run', id: createRunId() },
					restricted: false,
				},
			),
		).toEqual({
			AWS_ACCESS_KEY_ID: 'AK',
			AWS_SECRET_ACCESS_KEY: 'SK',
			AWS_ENDPOINT_URL_S3: 'https://s3.example',
			AWS_REGION: 'eu',
		});
	});

	it('reports an exchange failure to the caller and yields nothing', async () => {
		const failure = new Error('broker down');
		const { config } = wif(
			vi.fn(async () => {
				throw failure;
			}),
		);
		const onError = vi.fn();
		expect(
			await resolveFederatedVars(
				{ wif: config },
				{
					project: makeProject({ federation: { enabled: true } }),
					workload: { kind: 'job-run', id: createRunId() },
					restricted: false,
					onError,
				},
			),
		).toBeUndefined();
		expect(onError).toHaveBeenCalledWith(failure);
	});
});

describe('resolveIntegrationRender', () => {
	const render: SessionRender = {
		files: [],
		vars: { PGHOST: 'db' },
		attachments: [],
		warnings: [],
	};

	it('yields nothing without integrations or for a restricted sandbox', async () => {
		const { service } = integrations(render);
		expect(
			await resolveIntegrationRender(
				{},
				{
					projectId: makeProject().id,
					workload: { kind: 'job-run', id: createRunId() },
					principal: { userId: ACTOR, email: 'a@x' },
					restricted: false,
				},
			),
		).toBeUndefined();
		expect(
			await resolveIntegrationRender(
				{ integrations: service },
				{
					projectId: makeProject().id,
					workload: { kind: 'job-run', id: createRunId() },
					principal: { userId: ACTOR, email: 'a@x' },
					restricted: true,
				},
			),
		).toBeUndefined();
	});

	it('passes curated validation errors through and wraps everything else', async () => {
		const validation = integrations(async () => {
			throw new ValidationError('bad config');
		});
		const onError = vi.fn();
		await expect(
			resolveIntegrationRender(
				{ integrations: validation.service },
				{
					projectId: makeProject().id,
					workload: { kind: 'job-run', id: createRunId() },
					principal: { userId: ACTOR, email: 'a@x' },
					restricted: false,
					onError,
				},
			),
		).rejects.toBeInstanceOf(ValidationError);
		expect(onError).toHaveBeenCalledOnce();

		const vendor = integrations(async () => {
			throw new Error('connection string postgres://user:pw@db');
		});
		await expect(
			resolveIntegrationRender(
				{ integrations: vendor.service },
				{
					projectId: makeProject().id,
					workload: { kind: 'job-run', id: createRunId() },
					principal: { userId: ACTOR, email: 'a@x' },
					restricted: false,
				},
			),
		).rejects.toSatisfy(
			(err: unknown) => err instanceof UnavailableError && !err.message.includes('pw@db'),
		);
	});
});

describe('resolveJobSandboxEnv', () => {
	let bucket: MemoryBucket;
	let deps: ApiDeps;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		deps = makeTestDeps(bucket);
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns nothing when neither WIF nor integrations are configured', async () => {
		expect(await resolveJobSandboxEnv(deps, context())).toBeUndefined();
	});

	it('layers federated vars over the integration render', async () => {
		const { config } = wif();
		const { service } = integrations({
			files: [{ path: '/creds', content: 'x' }],
			vars: { AWS_ACCESS_KEY_ID: 'from-integration', PGHOST: 'db' },
			attachments: [],
			warnings: [],
		});
		const env = await resolveJobSandboxEnv(
			{ ...deps, wif: config, integrations: service },
			context(),
		);
		expect(env).toEqual({
			files: [{ path: '/creds', content: 'x' }],
			vars: {
				PGHOST: 'db',
				AWS_ACCESS_KEY_ID: 'AK',
				AWS_SECRET_ACCESS_KEY: 'SK',
				AWS_ENDPOINT_URL_S3: 'https://s3.example',
				AWS_REGION: 'eu',
			},
			defaults: {},
		});
	});

	it('attributes the render to the manual triggerer, else the job author, with their email', async () => {
		await deps.services.identities.upsert({ id: AUTHOR, email: 'author@example.com' });
		const { service, resolveForSession } = integrations({
			files: [],
			vars: {},
			attachments: [],
			warnings: [],
		});
		const withIntegrations = { ...deps, integrations: service };

		const scheduled = context();
		await resolveJobSandboxEnv(withIntegrations, scheduled);
		expect(resolveForSession).toHaveBeenLastCalledWith(scheduled.project.id, {
			workload: { kind: 'job-run', id: scheduled.run.run_id },
			principal: { userId: AUTHOR, email: 'author@example.com' },
		});

		const manual = context({ run: { trigger: 'manual', triggered_by: TRIGGERER } });
		await resolveJobSandboxEnv(withIntegrations, manual);
		expect(resolveForSession).toHaveBeenLastCalledWith(manual.project.id, {
			workload: { kind: 'job-run', id: manual.run.run_id },
			principal: { userId: TRIGGERER, email: '' },
		});
	});

	it('keeps the integration env when the WIF exchange fails, and logs it', async () => {
		const { config } = wif(
			vi.fn(async () => {
				throw new Error('broker down');
			}),
		);
		const { service } = integrations({
			files: [],
			vars: { PGHOST: 'db' },
			attachments: [],
			warnings: [],
		});
		const env = await resolveJobSandboxEnv(
			{ ...deps, wif: config, integrations: service },
			context(),
		);
		expect(env?.vars).toEqual({ PGHOST: 'db' });
		expect(
			vi
				.mocked(console.log)
				.mock.calls.some((c) => String(c[0]).includes('job_wif_exchange_failed')),
		).toBe(true);
	});

	it('fails closed when the integration render fails', async () => {
		const { service } = integrations(async () => {
			throw new Error('render exploded');
		});
		await expect(
			resolveJobSandboxEnv({ ...deps, integrations: service }, context()),
		).rejects.toBeInstanceOf(UnavailableError);
	});
});
