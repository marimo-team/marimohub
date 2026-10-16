import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorizationService, PreconditionFailedError, paths } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { ACTOR } from '@marimo-hub/core/testing';
import { expectOk } from './testing';
import { createAppSessionFixture, makeHeartbeatDue } from './testing/appSession';

const pause = async (ms: number) => {
	if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
};

type Operation = { method: string; key: string; conditional?: boolean; conflict?: boolean };

class MeasuredBucket extends MemoryBucket {
	operations: Operation[] = [];
	delay: (method: string, key: string) => number = () => 0;

	private async record(operation: Operation) {
		this.operations.push(operation);
		await pause(this.delay(operation.method, operation.key));
	}

	override async get(key: string) {
		await this.record({ method: 'get', key });
		return super.get(key);
	}

	override async head(key: string) {
		await this.record({ method: 'head', key });
		return super.head(key);
	}

	override async list(options?: Parameters<MemoryBucket['list']>[0]) {
		await this.record({ method: 'list', key: options?.prefix ?? '' });
		return super.list(options);
	}

	override async put(...args: Parameters<MemoryBucket['put']>) {
		const operation: Operation = {
			method: 'put',
			key: args[0],
			conditional: Boolean(args[2]?.onlyIfEtagMatches || args[2]?.onlyIfNotExists),
		};
		await this.record(operation);
		try {
			return await super.put(...args);
		} catch (error) {
			operation.conflict = error instanceof PreconditionFailedError;
			throw error;
		}
	}

	override async delete(key: string | string[]) {
		for (const item of Array.isArray(key) ? key : [key]) {
			await this.record({ method: 'delete', key: item });
		}
		return super.delete(key);
	}
}

const fixture = (labeled = false) => createAppSessionFixture(new MeasuredBucket(), labeled);

function counts(operations: Operation[]) {
	const reads = operations.filter((op) => ['get', 'head', 'list'].includes(op.method));
	const identityReads = reads.filter((op) => op.key.startsWith('_system/identities/')).length;
	return {
		metadataReads: reads.length - identityReads,
		identityReads,
		putAttempts: operations.filter((op) => op.method === 'put').length,
		identityPutAttempts: operations.filter(
			(op) => op.method === 'put' && op.key.startsWith('_system/identities/'),
		).length,
		conditionalPuts: operations.filter((op) => op.conditional).length,
		conflicts: operations.filter((op) => op.conflict).length,
		deletes: operations.filter((op) => op.method === 'delete').length,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('app operation budgets', () => {
	it('coalesces fresh heartbeats and never renews for a burst of proxy requests or upgrades', async () => {
		const f = await fixture();
		f.bucket.operations = [];
		await expectOk(await f.heartbeat());
		expect(counts(f.bucket.operations)).toMatchObject({ putAttempts: 0, deletes: 0 });
		const heartbeatReads = counts(f.bucket.operations).metadataReads;
		expect(f.bucket.operations).not.toContainEqual({ method: 'head', key: paths.catalog });
		const renew = vi.spyOn(f.client.deps.services.sessions, 'heartbeat');
		f.bucket.operations = [];
		for (let i = 0; i < 20; i++) expect(await f.proxy()).toMatchObject({ kind: 'forward' });
		expect(await f.proxy(true)).toMatchObject({ kind: 'forward' });
		expect(renew).not.toHaveBeenCalled();
		expect(counts(f.bucket.operations)).toMatchObject({
			metadataReads: 21 * 4,
			identityReads: 0,
			putAttempts: 0,
			deletes: 0,
		});
		expect(heartbeatReads).toBe(5);
	});

	it('reads changed notebook constraints on the next proxy request', async () => {
		const f = await fixture();
		expect(await f.proxy()).toMatchObject({ kind: 'forward' });
		await f.client.deps.services.notebooks.setSecurityLabels(
			f.project.id,
			f.notebook.id,
			{ classification: 'SECRET', compartments: [] },
			ACTOR,
		);
		vi.spyOn(f.resourceSecurity.subjectContext!, 'resolve').mockResolvedValue(null);
		f.bucket.operations = [];
		expect(await f.proxy()).toMatchObject({ kind: 'reject', status: 404 });
		expect(counts(f.bucket.operations).putAttempts).toBe(0);
		expect(
			f.bucket.operations.some((op) => op.key === paths.appPool(f.project.id, f.notebook.id)),
		).toBe(false);
	});

	it('coalesces concurrent due heartbeats across separate service instances using CAS', async () => {
		const f = await fixture();
		const clients = Array.from({ length: 4 }, () => f.newClient());
		const get = f.bucket.get.bind(f.bucket);
		const snapshotsReady = Promise.withResolvers<void>();
		let readers = 0;
		vi.spyOn(f.bucket, 'get').mockImplementation(async (key) => {
			const value = await get(key);
			if (key === paths.appPool(f.project.id, f.notebook.id) && readers < clients.length) {
				readers++;
				if (readers === clients.length) snapshotsReady.resolve();
				await snapshotsReady.promise;
			}
			return value;
		});
		makeHeartbeatDue();
		f.bucket.operations = [];
		const responses = await Promise.all(clients.map((client) => f.heartbeat(client)));
		for (const response of responses) expect((await expectOk(response)).status).toBe('running');
		const puts = f.bucket.operations.filter(
			(op) => op.method === 'put' && !op.key.startsWith('_system/identities/'),
		);
		expect(puts.every((op) => op.conditional)).toBe(true);
		expect(puts.filter((op) => !op.conflict)).toHaveLength(2);
		expect(puts.some((op) => op.conflict)).toBe(true);
		f.bucket.operations = [];
		await expectOk(await f.heartbeat());
		expect(counts(f.bucket.operations).putAttempts).toBe(0);
	});
});

const reportPath = process.env.APP_PERFORMANCE_REPORT;
it.skipIf(!reportPath)(
	'records repeatable latency and operation samples',
	async () => {
		const results = [];
		for (const profile of [
			{ name: 'memory', metadataMs: 0, projectMs: 0, policyMs: 0, labeled: false },
			{ name: 'remote', metadataMs: 10, projectMs: 10, policyMs: 0, labeled: false },
			{ name: 'slow-project-policy', metadataMs: 10, projectMs: 30, policyMs: 10, labeled: true },
		]) {
			for (const workload of [
				'fresh-heartbeat',
				'due-heartbeat',
				'concurrent-due-heartbeats',
				'proxy',
				'websocket-authorization',
				'reconnect',
			] as const) {
				const samples = [];
				for (let i = -2; i < 20; i++) {
					const f = await fixture(profile.labeled);
					const clients = Array.from({ length: 4 }, () => f.newClient());
					const authenticators = [f.client, ...clients].map((client) =>
						vi.spyOn(client.deps.authenticator, 'authenticate'),
					);
					const authorizer = vi.spyOn(AuthorizationService.prototype, 'authorize');
					const resolve = f.resourceSecurity.subjectContext!.resolve.bind(
						f.resourceSecurity.subjectContext,
					);
					const context = vi
						.spyOn(f.resourceSecurity.subjectContext!, 'resolve')
						.mockImplementation(async (...args) => {
							await pause(profile.policyMs);
							return resolve(...args);
						});
					const evaluate = f.resourceSecurity.constraints.evaluate.bind(
						f.resourceSecurity.constraints,
					);
					const constraint = vi
						.spyOn(f.resourceSecurity.constraints, 'evaluate')
						.mockImplementation(async (...args) => {
							await pause(profile.policyMs);
							return evaluate(...args);
						});
					f.bucket.delay = (_method, key) =>
						key.startsWith('_system/identities/')
							? 0
							: key === paths.project(f.project.id).meta
								? profile.projectMs
								: profile.metadataMs;
					if (workload.includes('due')) makeHeartbeatDue();
					f.bucket.operations = [];
					const start = performance.now();
					if (workload === 'proxy' || workload === 'websocket-authorization')
						expect(await f.proxy(workload === 'websocket-authorization')).toMatchObject({
							kind: 'forward',
						});
					else if (workload === 'reconnect') await expectOk(await f.admit());
					else if (workload === 'concurrent-due-heartbeats') {
						for (const response of await Promise.all(clients.map((client) => f.heartbeat(client))))
							await expectOk(response);
					} else await expectOk(await f.heartbeat());
					const elapsedMs = performance.now() - start;
					if (i >= 0)
						samples.push({
							elapsedMs,
							...counts(f.bucket.operations),
							authenticationCalls: authenticators.reduce(
								(sum, spy) => sum + spy.mock.calls.length,
								0,
							),
							authorizationCalls: authorizer.mock.calls.length,
							subjectContextCalls: context.mock.calls.length,
							constraintCalls: constraint.mock.calls.length,
							operations: f.bucket.operations,
						});
					vi.restoreAllMocks();
					vi.useRealTimers();
				}
				const times = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
				results.push({
					profile,
					workload,
					concurrency: workload === 'concurrent-due-heartbeats' ? 4 : 1,
					p50: times[9],
					p95: times[18],
					samples,
				});
			}
		}
		await writeFile(
			reportPath!,
			JSON.stringify(
				{
					environment: { node: process.version, platform: process.platform, arch: process.arch },
					warmups: 2,
					sampleCount: 20,
					kernel: 'fake compute; proxy authorization only; no kernel forwarding',
					results,
				},
				null,
				2,
			),
		);
	},
	180_000,
);
