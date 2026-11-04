import { z } from 'zod';
import { paths } from '../../paths';
import { listAllObjects } from '../catalog/storage';
import { ProjectId as ProjectIdValue } from '../../ids';
import type { Bucket } from '../../ports/bucket';
import type { NotebookId, ProjectId } from '../../ids';
import { DomainError, ValidationError, ConflictError, NotFoundError } from '../../errors';
import { KeyedSerialQueue } from '../../concurrency';
import { withCasRetry } from '../catalog/cas';

export const NotebookMutationGateSchema = z.object({
	schema_version: z.literal(1),
	writers: z.array(z.object({ token: z.string(), notebook_id: z.string().optional() })),
	moves: z.array(z.object({ token: z.string(), notebook_id: z.string() })),
	retired: z.array(z.string()),
});
type Gate = z.infer<typeof NotebookMutationGateSchema>;
const queues = new WeakMap<Bucket, KeyedSerialQueue<string>>();
const keyFor = paths.notebookMutation;

export class NotebookMutationGate {
	constructor(private readonly bucket: Bucket) {}

	private async change<T>(pid: ProjectId, update: (gate: Gate) => T): Promise<T> {
		let queue = queues.get(this.bucket);
		if (!queue) {
			queue = new KeyedSerialQueue<string>();
			queues.set(this.bucket, queue);
		}
		return queue.run(keyFor(pid), () =>
			withCasRetry(
				this.bucket,
				async (cas) => {
					const object = await this.bucket.get(keyFor(pid));
					const gate = object
						? NotebookMutationGateSchema.parse(await object.json())
						: {
								schema_version: 1 as const,
								writers: [],
								moves: [],
								retired: [],
							};
					const before = JSON.stringify(gate);
					const result = update(gate);
					if (JSON.stringify(gate) === before) return result;
					await cas.put(
						keyFor(pid),
						JSON.stringify(gate),
						object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
					);
					return result;
				},
				{ retries: 20 },
			),
		);
	}

	static async clearAbandonedWriters(
		bucket: Bucket,
		options: { writersStopped: true },
	): Promise<void> {
		if (!options.writersStopped) throw new ValidationError('Stop all writers before recovery');
		for (const object of await listAllObjects(bucket, paths.notebookMutations)) {
			const pid = ProjectIdValue.parse(object.key.slice(paths.notebookMutations.length, -5));
			await new NotebookMutationGate(bucket).change(pid, (gate) => {
				gate.writers = [];
			});
		}
	}

	static async assertRecoverySafe(bucket: Bucket): Promise<void> {
		for (const object of await listAllObjects(bucket, paths.notebookMutations)) {
			const record = await bucket.get(object.key);
			if (record && NotebookMutationGateSchema.parse(await record.json()).moves.length > 0)
				throw new ConflictError('Complete pending notebook moves before catalog recovery');
		}
	}

	async assertReadable(pid: ProjectId, nid: NotebookId): Promise<void> {
		const object = await this.bucket.get(keyFor(pid));
		if (!object) return;
		const gate = NotebookMutationGateSchema.parse(await object.json());
		if (gate.retired.includes(nid)) throw new NotFoundError(`Notebook ${nid} not found`);
		if (gate.moves.some((move) => move.notebook_id === nid))
			throw new NotFoundError(`Notebook ${nid} not found`);
	}

	async write<T>(pid: ProjectId, nid: NotebookId | undefined, run: () => Promise<T>): Promise<T> {
		const token = crypto.randomUUID();
		await this.change(pid, (gate) => {
			if (nid && gate.retired.includes(nid)) throw new NotFoundError(`Notebook ${nid} not found`);
			if (gate.moves.some((move) => !nid || move.notebook_id === nid))
				throw new ConflictError('Notebook move is in progress. Retry after the move completes.');
			gate.writers.push({ token, notebook_id: nid });
		});

		let release = true;
		try {
			return await run();
		} catch (error) {
			// An uncertain storage failure can complete remotely after the caller stops waiting.
			release = error instanceof DomainError && error.code !== 'SERVICE_UNAVAILABLE';
			throw error;
		} finally {
			if (release)
				await this.change(pid, (gate) => {
					gate.writers = gate.writers.filter((writer) => writer.token !== token);
				});
		}
	}

	async claim(pid: ProjectId, nid: NotebookId, token: string): Promise<void> {
		await this.change(pid, (gate) => {
			const existing = gate.moves.find((move) => move.notebook_id === nid);
			if (existing?.token === token) return;
			if (
				existing ||
				gate.writers.some((writer) => !writer.notebook_id || writer.notebook_id === nid)
			)
				throw new ConflictError(
					'Notebook has unfinished writes. Retry after they finish or an administrator recovers them.',
				);
			gate.moves.push({ token, notebook_id: nid });
		});
	}

	async release(pid: ProjectId, nid: NotebookId, token: string, retired?: boolean): Promise<void> {
		await this.change(pid, (gate) => {
			if (!gate.moves.some((move) => move.token === token && move.notebook_id === nid)) return;
			gate.moves = gate.moves.filter((move) => move.token !== token || move.notebook_id !== nid);
			if (retired !== undefined) gate.retired = gate.retired.filter((id) => id !== nid);
			if (retired) gate.retired.push(nid);
		});
	}
}

type AsyncMethod = (...args: never[]) => Promise<unknown>;
type Scope = { projectId: ProjectId; notebookId?: NotebookId };
type Guards<T> = {
	[K in keyof T]?: T[K] extends AsyncMethod ? (...args: Parameters<T[K]>) => Scope : never;
};

/** Admissions do not expire: a delayed storage write must finish before relocation can start. */
export function guardNotebookMutations<T extends object>(
	service: T,
	bucket: Bucket,
	guards: Guards<T>,
): void {
	const gate = new NotebookMutationGate(bucket);
	for (const key of Object.keys(guards) as (keyof T)[]) {
		const scope = guards[key] as (...args: unknown[]) => Scope;
		const method = service[key] as (...args: unknown[]) => Promise<unknown>;
		Object.defineProperty(service, key, {
			configurable: true,
			writable: true,
			value: async (...args: unknown[]) => {
				const target = scope(...args);
				return gate.write(target.projectId, target.notebookId, () => method.apply(service, args));
			},
		});
	}
}

export const notebookMutation = (projectId: ProjectId, notebookId: NotebookId): Scope => ({
	projectId,
	notebookId,
});
export const projectMutation = (projectId: ProjectId): Scope => ({ projectId });

/** Keep the mutation admission until every submitted write has settled. */
export async function awaitNotebookWrites(writes: Promise<unknown>[]): Promise<void> {
	const results = await Promise.allSettled(writes);
	const failure = results.find(
		(result): result is PromiseRejectedResult => result.status === 'rejected',
	);
	if (failure) throw failure.reason;
}
