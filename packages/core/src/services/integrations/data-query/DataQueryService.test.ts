import { describe, expect, it, vi } from 'vitest';
import { ResourceExhaustedError, ValidationError } from '../../../errors';
import type { IntegrationId, UserId } from '../../../ids';
import { DataQueryService, MAX_DATA_QUERY_SQL_BYTES } from './DataQueryService';
import type {
	DataQueryExecution,
	DataQueryExecutorFactory,
	DataQueryResult,
	DisposableDataQueryExecutor,
} from './contracts';

const user = 'user-1' as UserId;
const connection = {
	files: [{ path: '/tmp/marimohub-integrations/config.json', content: '{}' }],
	vars: { CATALOG: 'lake' },
	integration: { id: 'intg-1' as IntegrationId, name: 'lake', kind: 'test', version: 1 },
};

const serviceOptions = {
	maxConcurrent: 2,
	maxConcurrentPerUser: 1,
	maxRows: 100,
	maxBytes: 4096,
	executionTimeoutMs: 100,
};

function createService(
	executorFactory: DataQueryExecutorFactory,
	overrides: Partial<typeof serviceOptions> = {},
): DataQueryService {
	return new DataQueryService({ executorFactory, ...serviceOptions, ...overrides });
}

function setup(
	execute: (request: DataQueryExecution, signal: AbortSignal) => Promise<DataQueryResult>,
	overrides: Partial<typeof serviceOptions> = {},
) {
	const terminate = vi.fn();
	const executor: DisposableDataQueryExecutor = { runtime: 'worker', execute, terminate };
	const service = createService({ create: async () => executor }, overrides);
	return { service, terminate };
}

describe('DataQueryService', () => {
	it.each([
		['maxConcurrent', 0],
		['maxConcurrentPerUser', -1],
		['maxRows', 1.5],
		['maxBytes', Number.NaN],
		['executionTimeoutMs', Number.POSITIVE_INFINITY],
	] as const)('rejects an invalid %s option', (name, value) => {
		expect(() =>
			setup(async () => ({ columns: [], rows: [], truncated: false }), { [name]: value }),
		).toThrow(name);
	});

	it('passes fixed isolation controls to a fresh executor and terminates it', async () => {
		const executions: DataQueryExecution[] = [];
		let signal: AbortSignal | undefined;
		const { service, terminate } = setup(async (request, requestSignal) => {
			executions.push(request);
			signal = requestSignal;
			return { columns: ['one'], rows: [[1]], truncated: false };
		});

		await expect(service.query(user, { sql: 'select 1', connection })).resolves.toEqual({
			columns: ['one'],
			rows: [[1]],
			truncated: false,
		});
		expect(executions).toEqual([
			expect.objectContaining({
				sql: 'select 1',
				connection,
				accessMode: 'read-only',
				limits: { maxRows: 100, maxBytes: 4096, deadlineMs: 100 },
			}),
		]);
		expect(terminate).toHaveBeenCalledOnce();
		expect(signal?.aborted).toBe(true);
	});

	it('hard-terminates a query at its deadline', async () => {
		const { service, terminate } = setup(() => new Promise(() => {}), {
			executionTimeoutMs: 10,
		});

		await expect(service.query(user, { sql: 'select 1', connection })).rejects.toThrow('timed out');
		expect(terminate).toHaveBeenCalled();
	});

	it('bounds factory creation and terminates an executor that resolves after the deadline', async () => {
		let resolveFactory!: (executor: DisposableDataQueryExecutor) => void;
		const terminate = vi.fn();
		const service = createService(
			{
				create: () =>
					new Promise((resolve) => {
						resolveFactory = resolve;
					}),
			},
			{ maxConcurrent: 1, maxRows: 1, maxBytes: 100, executionTimeoutMs: 10 },
		);
		await expect(service.query(user, { sql: 'select 1', connection })).rejects.toThrow('timed out');

		resolveFactory({
			runtime: 'worker',
			execute: vi.fn(),
			terminate,
		});
		await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
	});

	it('closes promptly while factory creation is pending and terminates a late executor', async () => {
		let resolveFactory!: (executor: DisposableDataQueryExecutor) => void;
		const terminate = vi.fn();
		const service = createService(
			{
				create: () =>
					new Promise((resolve) => {
						resolveFactory = resolve;
					}),
			},
			{ maxConcurrent: 1, maxRows: 1, maxBytes: 100, executionTimeoutMs: 10_000 },
		);
		const query = service.query(user, { sql: 'select 1', connection });
		await vi.waitFor(() => expect(resolveFactory).toBeTypeOf('function'));

		await expect(service.close()).resolves.toBeUndefined();
		await expect(query).rejects.toThrow('closed');
		resolveFactory({ runtime: 'process', execute: vi.fn(), terminate });
		await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
	});

	it('terminates an active executor once when close interrupts execution', async () => {
		const execute = vi.fn(() => new Promise<DataQueryResult>(() => {}));
		const { service, terminate } = setup(execute, { executionTimeoutMs: 10_000 });
		const query = service.query(user, { sql: 'select 1', connection });
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

		await expect(service.close()).resolves.toBeUndefined();
		await expect(query).rejects.toThrow('closed');
		expect(terminate).toHaveBeenCalledOnce();
	});

	it('shares teardown completion across concurrent close calls', async () => {
		const execute = vi.fn(() => new Promise<DataQueryResult>(() => {}));
		const { service } = setup(execute, { executionTimeoutMs: 10_000 });
		const query = service.query(user, { sql: 'select 1', connection });
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

		const first = service.close();
		const second = service.close();
		expect(second).toBe(first);
		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
		await expect(query).rejects.toThrow('closed');
	});

	it('rejects inline execution and disposes the executor', async () => {
		const terminate = vi.fn();
		const service = createService(
			{
				create: async () =>
					({
						runtime: 'inline',
						execute: vi.fn(),
						terminate,
					}) as unknown as DisposableDataQueryExecutor,
			},
			{ maxConcurrent: 1, maxRows: 1, maxBytes: 100 },
		);

		await expect(service.query(user, { sql: 'select 1', connection })).rejects.toThrow(
			'not execute',
		);
		expect(terminate).toHaveBeenCalledOnce();
	});

	it.each([
		new Error('provider failed for password=hunter2'),
		new ValidationError('invalid password=hunter2'),
		new ResourceExhaustedError('quota key=hunter2'),
	])('does not surface executor errors or secret-bearing messages', async (failure) => {
		const { service } = setup(async () => {
			throw failure;
		});

		await expect(service.query(user, { sql: 'select 1', connection })).rejects.toMatchObject({
			message: 'The data-query runtime could not execute this query.',
		});
	});

	it('ignores synchronous termination errors after preserving the query outcome', async () => {
		const terminate = vi.fn(() => {
			throw new Error('teardown failed');
		});
		const service = createService(
			{
				create: async () => ({
					runtime: 'process',
					execute: async () => ({ columns: ['value'], rows: [[1]], truncated: false }),
					terminate,
				}),
			},
			{ maxConcurrent: 1, maxRows: 1, maxBytes: 100 },
		);

		await expect(service.query(user, { sql: 'select 1', connection })).resolves.toEqual({
			columns: ['value'],
			rows: [[1]],
			truncated: false,
		});
		expect(terminate).toHaveBeenCalledOnce();
	});

	it.each([
		['non-array columns', { columns: 'value', rows: [], truncated: false }],
		['non-string column', { columns: [1], rows: [], truncated: false }],
		['non-array rows', { columns: [], rows: null, truncated: false }],
		['non-array row', { columns: ['value'], rows: [1], truncated: false }],
		['wrong row width', { columns: ['value'], rows: [[]], truncated: false }],
		['missing truncation flag', { columns: [], rows: [] }],
	] as const)('rejects a malformed result with %s', async (_name, result) => {
		const { service } = setup(async () => result as never);

		await expect(service.query(user, { sql: 'select 1', connection })).rejects.toThrow(
			'could not execute',
		);
	});

	it('rejects a cyclic result that cannot be serialized', async () => {
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		const { service } = setup(async () => ({
			columns: ['value'],
			rows: [cyclic],
			truncated: false,
		}));

		await expect(service.query(user, { sql: 'select 1', connection })).rejects.toThrow(
			'could not execute',
		);
	});

	it('enforces SQL, row, and byte limits independently of the executor', async () => {
		const { service } = setup(
			async () => ({
				columns: ['value'],
				rows: [[1], [2]],
				truncated: false,
			}),
			{ maxRows: 1 },
		);
		await expect(service.query(user, { sql: ' ', connection })).rejects.toThrow(
			'must not be empty',
		);
		await expect(
			service.query(user, { sql: 'x'.repeat(MAX_DATA_QUERY_SQL_BYTES + 1), connection }),
		).rejects.toThrow('byte limit');
		await expect(service.query(user, { sql: 'select 1', connection })).rejects.toThrow(
			'could not execute',
		);

		const oversized = setup(
			async () => ({ columns: ['value'], rows: [['long value']], truncated: false }),
			{ maxBytes: 10 },
		).service;
		await expect(oversized.query(user, { sql: 'select 1', connection })).rejects.toThrow(
			'could not execute',
		);

		const exactBytes = 'é'.repeat(MAX_DATA_QUERY_SQL_BYTES / 2);
		const exactService = setup(async () => ({ columns: [], rows: [], truncated: false })).service;
		await expect(exactService.query(user, { sql: exactBytes, connection })).resolves.toEqual({
			columns: [],
			rows: [],
			truncated: false,
		});
		await expect(exactService.query(user, { sql: `${exactBytes}é`, connection })).rejects.toThrow(
			'byte limit',
		);
	});

	it('applies separate global and per-user admission and rejects work after close', async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { service } = setup(async () => {
			await pending;
			return { columns: [], rows: [], truncated: false };
		});
		const first = service.query(user, { sql: 'select 1', connection });
		await expect(service.query(user, { sql: 'select 2', connection })).rejects.toThrow(
			'already running',
		);
		const other = service.query('user-2' as UserId, { sql: 'select 3', connection });
		await expect(
			service.query('user-3' as UserId, { sql: 'select 4', connection }),
		).rejects.toThrow('currently full');
		release();
		await Promise.all([first, other]);
		await service.close();
		await expect(service.query(user, { sql: 'select 5', connection })).rejects.toThrow('closed');
	});
});
