import { describe, expect, it, vi } from 'vitest';
import type { HubStorage } from '../ports/metadata';
import { createServices } from '../services';
import { SYSTEM_ACTOR, UserId, SandboxId, ProjectId, NotebookId, createRunId } from '../ids';
import { ConversationService } from '../services/chat/ConversationService';
import { paths } from '../paths';

export function metadataCompositionContract(
	name: string,
	makeStorage: () => Promise<HubStorage>,
): void {
	describe(`Metadata domain composition: ${name}`, () => {
		async function fixture() {
			const storage = await makeStorage();
			const services = createServices(storage);
			await services.catalog.initialize(SYSTEM_ACTOR);
			const project = await services.projects.createProject(
				{ name: 'parity', description: '' },
				SYSTEM_ACTOR,
			);
			const notebook = await services.notebooks.createNotebook(
				project.id,
				{ title: 'parity', description: '', code: 'print(1)' },
				SYSTEM_ACTOR,
			);
			return {
				storage,
				services,
				replica: createServices(storage),
				project,
				notebook,
				keys: paths.project(project.id).notebook(notebook.id),
			};
		}
		it('elects one editor across independent service replicas', async () => {
			const { services, replica, project, notebook } = await fixture();
			const sessions = await Promise.all(
				[services, replica].map((service) =>
					service.sessions.createSession({
						project_id: project.id,
						notebook_id: notebook.id,
						user_id: SYSTEM_ACTOR,
						mode: 'edit',
					}),
				),
			);
			const claims = await Promise.all(
				[services, replica].map((service, index) =>
					service.sessions.claimEditor(
						project.id,
						notebook.id,
						sessions[index].session_id,
						'shared',
						SYSTEM_ACTOR,
					),
				),
			);
			expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
			expect(claims[0].claim.session_id).toBe(claims[1].claim.session_id);
		});
		it.each(['edit', 'app'] as const)(
			'keeps %s termination authoritative against a late heartbeat',
			async (mode) => {
				const { services, replica, project, notebook } = await fixture();
				const session = await services.sessions.createSession({
					project_id: project.id,
					notebook_id: notebook.id,
					user_id: SYSTEM_ACTOR,
					mode,
				});
				await services.sessions.markTerminated(project.id, session.session_id);
				await replica.sessions.heartbeat(project.id, session.session_id);
				expect((await services.sessions.getSession(project.id, session.session_id)).status).toBe(
					'terminated',
				);
			},
		);
		it('keeps terminal app sandboxes counted until provider reclamation is recorded', async () => {
			const { services, replica, project, notebook } = await fixture();
			const session = await services.sessions.createSession({
				project_id: project.id,
				notebook_id: notebook.id,
				user_id: SYSTEM_ACTOR,
				mode: 'app',
				sandbox_id: SandboxId.create(),
			});
			await services.sessions.markFailed(project.id, session.session_id);
			expect(
				(await replica.sessions.listActiveAppsForProject(project.id)).map((s) => s.session_id),
			).toContain(session.session_id);
			await services.sessions.markSandboxReclaimed(
				project.id,
				session.session_id,
				new Date().toISOString(),
				session.sandbox_id,
			);
			expect(await replica.sessions.listActiveAppsForProject(project.id)).toEqual([]);
		});
		it('advances the source fence for unchanged capture and rejects an older publication', async () => {
			const { services, replica, project, notebook, storage, keys } = await fixture();
			const token = await services.notebooks.beginSessionCapture(project.id, notebook.id);
			await replica.notebooks.commitSession(
				project.id,
				notebook.id,
				{ code: 'print(1)' },
				SYSTEM_ACTOR,
			);
			expect((await storage.metadata.head(keys.source))!.etag).not.toBe(token.etag);
			await expect(
				services.notebooks.commitSession(
					project.id,
					notebook.id,
					{ code: 'stale' },
					SYSTEM_ACTOR,
					token,
				),
			).rejects.toThrow('publication changed');
		});
		it('does not publish a source head when an immutable artifact upload fails', async () => {
			const { services, project, notebook, storage, keys } = await fixture();
			const before = (await storage.metadata.head(keys.source))!.etag;
			const put = storage.logicalBucket.put.bind(storage.logicalBucket);
			const fault = vi
				.spyOn(storage.logicalBucket, 'put')
				.mockImplementation((key, value, options) => {
					if (key.endsWith('/notebook.py'))
						return Promise.reject(new Error('artifact unavailable'));
					return put(key, value, options);
				});
			try {
				await expect(
					services.notebooks.commitSession(
						project.id,
						notebook.id,
						{ code: 'print(2)' },
						SYSTEM_ACTOR,
					),
				).rejects.toThrow('artifact unavailable');
			} finally {
				fault.mockRestore();
			}
			expect((await storage.metadata.head(keys.source))!.etag).toBe(before);
		});
		it('discovers a publication whose success reply was lost', async () => {
			const { services, replica, project, notebook, storage, keys } = await fixture();
			const token = await services.notebooks.beginSessionCapture(project.id, notebook.id);
			const put = storage.logicalBucket.put.bind(storage.logicalBucket);
			const fault = vi
				.spyOn(storage.logicalBucket, 'put')
				.mockImplementation(async (key, value, options) => {
					const result = await put(key, value, options);
					if (key === keys.source) throw new Error('lost publication reply');
					return result;
				});
			try {
				await expect(
					services.notebooks.commitSession(
						project.id,
						notebook.id,
						{ code: 'print(2)' },
						SYSTEM_ACTOR,
						token,
					),
				).rejects.toThrow('lost publication reply');
			} finally {
				fault.mockRestore();
			}
			const current = await replica.notebooks.beginSessionCapture(project.id, notebook.id);
			expect(current.etag).not.toBe(token.etag);
			expect(
				await (await storage.artifacts.get(
					keys.version(current.source.current_version_id).code,
				))!.text(),
			).toBe('print(2)');
		});
		it('keeps capture acknowledgements monotonic across replicas', async () => {
			const { services, replica, project, notebook } = await fixture();
			const session = await services.sessions.createSession({
				project_id: project.id,
				notebook_id: notebook.id,
				user_id: SYSTEM_ACTOR,
			});
			const capture = await services.notebooks.beginSessionCapture(project.id, notebook.id);
			await services.sessions.recordDurableCapture(
				session,
				'2026-11-18T02:00:00Z',
				capture.source.current_version_id,
			);
			await replica.sessions.recordDurableCapture(
				session,
				'2026-11-18T01:00:00Z',
				capture.source.current_version_id,
			);
			expect(
				(await services.sessions.getSession(project.id, session.session_id)).last_durable_capture
					?.at,
			).toBe('2026-11-18T02:00:00Z');
		});
		it('retains a single occurrence winner across replicas', async () => {
			const { services, replica, project, notebook } = await fixture();
			const job = await services.jobs.createJob(
				project.id,
				notebook.id,
				{ name: 'parity' },
				SYSTEM_ACTOR,
			);
			const claims = await Promise.all(
				[services, replica].map((service) =>
					service.jobRuns.claimOccurrence(
						job,
						'2026-11-18T01:00:00Z',
						createRunId(),
						'2026-11-18T01:00:00Z',
					),
				),
			);
			expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
		});
		it('deletes job metadata and retained output artifacts together during cleanup', async () => {
			const { services, storage, project, notebook } = await fixture();
			const job = await services.jobs.createJob(
				project.id,
				notebook.id,
				{ name: 'cleanup' },
				SYSTEM_ACTOR,
			);
			const prefix = paths.project(project.id).notebook(notebook.id).job(job.id).base;
			const output = `${prefix}runs/${createRunId()}/output.html`;
			await storage.logicalBucket.put(output, '<html>result</html>');
			await services.jobs.beginDelete(project.id, notebook.id, job.id, SYSTEM_ACTOR);
			await services.jobs.finishDelete(project.id, notebook.id, job.id);
			expect(await storage.artifacts.head(output)).toBeNull();
			expect((await storage.logicalBucket.list({ prefix })).objects).toEqual([]);
		});
		it('moves metadata and payloads across projects and retains the deletion state', async () => {
			const { services, storage, project, notebook, keys } = await fixture();
			const destination = await services.projects.createProject(
				{ name: 'destination', description: '' },
				SYSTEM_ACTOR,
			);
			const moved = await services.moves.move({
				source: project.id,
				destination: destination.id,
				notebookId: notebook.id,
				actor: SYSTEM_ACTOR,
				expectedVersion: notebook.updated_at,
				authorize: async () => {},
			});
			const reopened = createServices(storage);
			expect(await reopened.notebooks.getNotebookContent(destination.id, notebook.id)).toBe(
				'print(1)',
			);
			expect((await storage.logicalBucket.list({ prefix: `${keys.base}/` })).objects).toEqual([]);
			await reopened.notebooks.deleteNotebook(
				destination.id,
				notebook.id,
				SYSTEM_ACTOR,
				moved.updated_at,
			);
			const deleted = await storage.metadata.get(
				paths.project(destination.id).notebook(notebook.id).meta,
			);
			expect((await deleted!.json<{ status: string }>()).status).toBe('deleted');
		});
		it('enforces private conversation ownership after reopening services', async () => {
			const { storage, project } = await fixture();
			const first = new ConversationService(storage.logicalBucket);
			const conversation = await first.create(project.id, SYSTEM_ACTOR);
			const second = new ConversationService(storage.logicalBucket);
			await expect(
				second.get(project.id, UserId.parse('other-owner'), conversation.id),
			).rejects.toThrow();
			expect((await second.get(project.id, SYSTEM_ACTOR, conversation.id)).id).toBe(
				conversation.id,
			);
		});
		it('preserves token revocation across a fresh process cache', async () => {
			const { services, storage } = await fixture();
			const token = await services.tokens.create({ name: 'parity' }, SYSTEM_ACTOR);
			await services.tokens.revoke(SYSTEM_ACTOR, token.record.id);
			expect(await createServices(storage).tokens.verify(token.token)).toBeNull();
		});

		it('publishes concurrent catalog updates through the metadata pointer', async () => {
			const storage = await makeStorage();
			const services = createServices(storage);
			await services.catalog.initialize(SYSTEM_ACTOR);
			const projects = await Promise.all(
				['one', 'two'].map((name) =>
					services.projects.createProject({ name, description: '' }, SYSTEM_ACTOR),
				),
			);
			const snapshot = await services.catalog.getCurrentSnapshot();
			expect(snapshot.projects.map((project) => project.id)).toEqual(
				expect.arrayContaining(projects.map((project) => project.id)),
			);
			expect(await storage.metadata.get(paths.catalog)).not.toBeNull();
		});
		it('keeps notebook payloads separate while sessions retain domain transitions', async () => {
			const storage = await makeStorage();
			const services = createServices(storage);
			await services.catalog.initialize(SYSTEM_ACTOR);
			const project = await services.projects.createProject(
				{ name: 'test', description: '' },
				SYSTEM_ACTOR,
			);
			const notebook = await services.notebooks.createNotebook(
				project.id,
				{ title: 'test', description: '', code: 'print(1)' },
				SYSTEM_ACTOR,
			);
			const keys = paths.project(project.id).notebook(notebook.id);
			expect(await storage.metadata.get(keys.meta)).not.toBeNull();
			expect(await storage.metadata.get(keys.source)).not.toBeNull();
			const artifacts = await storage.artifacts.list({ prefix: `${keys.base}/` });
			expect(artifacts.objects.some((object) => object.key.endsWith('notebook.py'))).toBe(true);
			const session = await services.sessions.createSession({
				project_id: project.id,
				notebook_id: notebook.id,
				user_id: SYSTEM_ACTOR,
				mode: 'edit',
			});
			expect(
				(await services.sessions.listActiveByProject(project.id)).map(
					(record) => record.session_id,
				),
			).toContain(session.session_id);
			await services.sessions.markFailed(project.id, session.session_id);
			expect(await services.sessions.listActiveByProject(project.id)).toEqual([]);
			expect(
				await storage.metadata.get(paths.session(project.id, session.session_id)),
			).not.toBeNull();
		});
	});
}

export function atomicMetadataContract(makeStorage: () => Promise<HubStorage>): void {
	describe('atomic metadata domain operations', () => {
		async function fixture() {
			const storage = await makeStorage();
			const services = createServices(storage);
			await services.catalog.initialize(SYSTEM_ACTOR);
			const project = await services.projects.createProject(
				{ name: 'atomic', description: '' },
				SYSTEM_ACTOR,
			);
			const notebook = await services.notebooks.createNotebook(
				project.id,
				{ title: 'atomic', description: '', code: 'print(1)' },
				SYSTEM_ACTOR,
			);
			const session = await services.sessions.createSession({
				project_id: project.id,
				notebook_id: notebook.id,
				user_id: SYSTEM_ACTOR,
				sandbox_id: SandboxId.create(),
			});
			await services.sessions.claimEditor(
				project.id,
				notebook.id,
				session.session_id,
				'shared',
				SYSTEM_ACTOR,
			);
			return { storage, services, project, notebook, session };
		}
		it('publishes unchanged capture and its durable acknowledgement together', async () => {
			const { storage, services, project, notebook, session } = await fixture();
			const token = await services.notebooks.beginSessionCapture(project.id, notebook.id);
			const result = await services.notebooks.commitSession(
				project.id,
				notebook.id,
				{ code: 'print(1)' },
				SYSTEM_ACTOR,
				token,
				{ session },
			);
			expect(result?.newVersion).toBe(false);
			expect(result?.captureAcknowledgedAt).toBeDefined();
			expect(
				(await storage.metadata.head(paths.project(project.id).notebook(notebook.id).source))!.etag,
			).not.toBe(token.etag);
			expect(
				(await services.sessions.getSession(project.id, session.session_id)).last_durable_capture,
			).toEqual({ at: result!.captureAcknowledgedAt, version_id: result!.versionId });
		});
		it('rolls back source publication when writing its session receipt fails', async () => {
			const { storage, services, project, notebook, session } = await fixture();
			const token = await services.notebooks.beginSessionCapture(project.id, notebook.id);
			const broken = createServices({
				...storage,
				transactions: {
					run: (scopes, work) =>
						storage.transactions!.run(scopes, async (tx) => {
							const put = tx.records.put;
							tx.records.put = (key, value, options) => {
								if (key === paths.session(project.id, session.session_id))
									throw new Error('receipt write failed');
								return put(key, value, options);
							};
							return work(tx);
						}),
				},
			});
			await expect(
				broken.notebooks.commitSession(
					project.id,
					notebook.id,
					{ code: 'print(2)' },
					SYSTEM_ACTOR,
					token,
					{ session },
				),
			).rejects.toThrow();
			expect(
				(await storage.metadata.head(paths.project(project.id).notebook(notebook.id).source))!.etag,
			).toBe(token.etag);
			expect(
				(await services.sessions.getSession(project.id, session.session_id)).last_durable_capture,
			).toBeUndefined();
		});
		it('rejects an old runtime after ownership changes without advancing publication', async () => {
			const { storage, services, project, notebook, session } = await fixture();
			const token = await services.notebooks.beginSessionCapture(project.id, notebook.id);
			await services.sessions.markSandboxReclaimed(
				project.id,
				session.session_id,
				new Date().toISOString(),
				session.sandbox_id,
			);
			await expect(
				services.notebooks.commitSession(
					project.id,
					notebook.id,
					{ code: 'old' },
					SYSTEM_ACTOR,
					token,
					{ session },
				),
			).rejects.toThrow('no longer owns');
			expect(
				(await storage.metadata.head(paths.project(project.id).notebook(notebook.id).source))!.etag,
			).toBe(token.etag);
		});
		it('admits one competing editor within the user cap and rolls back the loser', async () => {
			const { storage, services, project, notebook, session } = await fixture();
			await services.sessions.markTerminated(project.id, session.session_id);
			await services.sessions.markSandboxReclaimed(
				project.id,
				session.session_id,
				new Date().toISOString(),
				session.sandbox_id,
			);
			const replica = createServices(storage);
			const policy = {
				maxConcurrentSessionsPerUser: 1,
				projectUpdatedAt: project.updated_at,
				notebookUpdatedAt: (await services.notebooks.getNotebook(project.id, notebook.id)).meta
					.updated_at,
			};
			const results = await Promise.allSettled(
				[services, replica].map((service) =>
					service.sessions.createSessionWithEtag(
						{
							project_id: project.id,
							notebook_id: notebook.id,
							user_id: SYSTEM_ACTOR,
							mode: 'edit',
						},
						policy,
					),
				),
			);
			expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			const failed = results.find((result) => result.status === 'rejected');
			expect(failed).toMatchObject({ reason: { code: 'RESOURCE_EXHAUSTED' } });
			expect(await services.sessions.listActiveForUser(SYSTEM_ACTOR)).toHaveLength(1);
		});
		it('rejects admission after policy revisions change without inserting a session', async () => {
			const { storage, services, project, notebook } = await fixture();
			const before = (await storage.metadata.list({ prefix: paths.sessionsPrefix })).objects.length;
			await expect(
				services.sessions.createSessionWithEtag(
					{ project_id: project.id, notebook_id: notebook.id, user_id: SYSTEM_ACTOR },
					{ projectUpdatedAt: 'stale', notebookUpdatedAt: notebook.updated_at },
				),
			).rejects.toThrow('policy changed');
			expect((await storage.metadata.list({ prefix: paths.sessionsPrefix })).objects).toHaveLength(
				before,
			);
		});
		it('rolls back session creation if index registration is corrupt', async () => {
			const storage = await makeStorage();
			const services = createServices(storage);
			await storage.metadata.put(paths.sessionIndexForUser(SYSTEM_ACTOR), '{}');
			await expect(
				services.sessions.createSession({
					project_id: ProjectId.create(),
					notebook_id: NotebookId.create(),
					user_id: SYSTEM_ACTOR,
				}),
			).rejects.toThrow();
			expect((await storage.metadata.list({ prefix: paths.sessionsPrefix })).objects).toHaveLength(
				0,
			);
		});
	});
}

export async function benchmarkMetadataCohort(storage: HubStorage, samples = 30) {
	const counters = { calls: 0, writtenBytes: 0, readBytes: 0, transactions: 0, sessionPages: 0 };
	function counted(bucket: HubStorage['metadata']): HubStorage['metadata'] {
		return {
			get: (async (...args: Parameters<HubStorage['metadata']['get']>) => {
				counters.calls++;
				const object = await bucket.get(...args);
				if (object && !('notModified' in object)) counters.readBytes += object.size;
				return object;
			}) as HubStorage['metadata']['get'],
			head: (key) => {
				counters.calls++;
				return bucket.head(key);
			},
			list: (options) => {
				counters.calls++;
				return bucket.list(options);
			},
			delete: (keys) => {
				counters.calls++;
				return bucket.delete(keys);
			},
			put: (key, value, options) => {
				counters.calls++;
				counters.writtenBytes +=
					typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength;
				return bucket.put(key, value, options);
			},
		};
	}
	const measured: HubStorage = {
		...storage,
		logicalBucket: counted(storage.logicalBucket),
		metadata: counted(storage.metadata),
		...(storage.sessions
			? {
					sessions: {
						list: (query) => {
							counters.sessionPages++;
							return storage.sessions!.list(query);
						},
					},
				}
			: {}),
		...(storage.transactions
			? {
					transactions: {
						run: (scopes, work) => {
							counters.transactions++;
							return storage.transactions!.run(scopes, (tx) =>
								work({ ...tx, records: counted(tx.records) }),
							);
						},
					},
				}
			: {}),
	};
	const services = createServices(measured);
	await services.catalog.initialize(SYSTEM_ACTOR);
	const project = await services.projects.createProject(
		{ name: 'benchmark', description: '' },
		SYSTEM_ACTOR,
	);
	const notebook = await services.notebooks.createNotebook(
		project.id,
		{ title: 'benchmark', description: '', code: 'print(1)' },
		SYSTEM_ACTOR,
	);
	const times: Record<string, number[]> = {};
	async function measure<T>(name: string, work: () => Promise<T>) {
		const start = performance.now();
		const result = await work();
		(times[name] ??= []).push(performance.now() - start);
		return result;
	}
	for (let sample = 0; sample < samples; sample++) {
		const session = await measure('session-create', () =>
			services.sessions.createSession({
				project_id: project.id,
				notebook_id: notebook.id,
				user_id: SYSTEM_ACTOR,
				sandbox_id: SandboxId.create(),
			}),
		);
		await services.sessions.claimEditor(
			project.id,
			notebook.id,
			session.session_id,
			'shared',
			SYSTEM_ACTOR,
		);
		await services.sessions.setRunning(project.id, session.session_id, 'http://runtime.test');
		await measure('session-list', () => services.sessions.listActiveByProject(project.id));
		await measure('reuse', () =>
			services.sessions.findReusableEditor(project.id, notebook.id, SYSTEM_ACTOR, 'shared', false),
		);
		await measure('heartbeat', () => services.sessions.heartbeat(project.id, session.session_id));
		await measure('capture', async () => {
			const token = await services.notebooks.beginSessionCapture(project.id, notebook.id);
			const result = await services.notebooks.commitSession(
				project.id,
				notebook.id,
				{ code: 'print(1)' },
				SYSTEM_ACTOR,
				token,
				...(storage.transactions ? [{ session }] : []),
			);
			if (!storage.transactions)
				await services.sessions.recordDurableCapture(
					session,
					new Date().toISOString(),
					result!.versionId,
				);
		});
		await measure('stop-metadata', async () => {
			await services.sessions.markTerminated(project.id, session.session_id);
			await services.sessions.markSandboxReclaimed(
				project.id,
				session.session_id,
				new Date().toISOString(),
				session.sandbox_id,
			);
		});
		await measure('reopen', () =>
			createServices(measured).sessions.getSession(project.id, session.session_id),
		);
	}
	return {
		samples,
		counters,
		milliseconds: Object.fromEntries(
			Object.entries(times).map(([name, values]) => {
				const sorted = values.toSorted((a, b) => a - b);
				return [
					name,
					{
						cold: values[0],
						median: sorted[Math.floor(sorted.length / 2)],
						p95: sorted[Math.floor(sorted.length * 0.95)],
					},
				];
			}),
		),
	};
}
