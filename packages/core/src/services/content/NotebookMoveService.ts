import { SearchIndexer } from '../../search/SearchIndexer';
import { buildNotebookEntry } from './notebookMeta';
import { jobIndexEntry } from '../jobs/JobsService';
import { UserId as UserIdValue } from '../../ids';
import { ResumableUploads } from './ResumableUploads';
import { AppPoolStore } from '../runtime/AppPoolStore';
import { EventService } from '../catalog/EventService';
import { z } from 'zod';
import type { Bucket } from '../../ports/bucket';
import type { NotebookId, ProjectId, UserId } from '../../ids';
import { ValidationError, ConflictError, NotFoundError, assertVersionMatch } from '../../errors';
import { sha256Hex } from '../../internal/sha256';
import { paths } from '../../paths';
import {
	NotebookMetaSchema,
	ProjectSchema,
	SourceSchema,
	FsSnapshotSchema,
	ProjectIdSchema,
	NotebookIdSchema,
	UserIdSchema,
	readStored,
} from '../../schema';
import type { NotebookMeta, Project, Source, FsSnapshot } from '../../schema';
import type { CatalogService } from '../catalog/CatalogService';
import { listAllObjects } from '../catalog/storage';
import { withCasRetry } from '../catalog/cas';
import { NotebookMutationGate } from './NotebookMutationGate';
import type { NotebookService } from './NotebookService';
import type { SessionService } from '../runtime/SessionService';
import type { JobsService } from '../jobs/JobsService';
import type { JobRunService } from '../jobs/JobRunService';
import type { NotebookProposalService } from './NotebookProposalService';
import type { NotebookPreviewService } from './NotebookPreviewService';
import type { DeepLinkService } from './DeepLinkService';

export const NotebookMoveSchema = z.object({
	schema_version: z.literal(1),
	id: z.string(),
	idempotency_key: z.string(),
	source: ProjectIdSchema,
	destination: ProjectIdSchema,
	notebook_id: NotebookIdSchema,
	actor: UserIdSchema,
	updated_at: z.string(),
	phase: z.enum(['preparing', 'copying', 'published', 'complete']),
	executor: z.string().nullable(),
	runtimes: z.array(NotebookIdSchema),
	snapshots: z.array(FsSnapshotSchema).default([]),
	search_refreshed: z.boolean().default(false),
	meta: NotebookMetaSchema,
	source_record: SourceSchema,
});
type Move = z.infer<typeof NotebookMoveSchema>;

function movedNotebookMeta(move: Move): NotebookMeta {
	return { ...move.meta, project_id: move.destination, updated_at: move.updated_at };
}

async function releaseCompletedMove(bucket: Bucket, move: Move): Promise<NotebookMeta> {
	const gate = new NotebookMutationGate(bucket);
	for (const nid of [move.notebook_id, ...move.runtimes]) {
		await gate.release(move.source, nid, move.id, true);
		await gate.release(move.destination, nid, move.id, false);
	}
	if (!move.search_refreshed) {
		const current = await bucket.get(paths.notebookMove(move.id));
		if (!current) throw new ConflictError('Move record is missing');
		if (NotebookMoveSchema.parse(await current.json()).search_refreshed)
			return movedNotebookMeta(move);
		await SearchIndexer.requestRefresh(bucket, move.source, move.id);
		await SearchIndexer.requestRefresh(bucket, move.destination, move.id);
		await withCasRetry(bucket, async (cas) => {
			const key = paths.notebookMove(move.id);
			const object = await bucket.get(key);
			if (!object) throw new ConflictError('Move record is missing');
			const record = NotebookMoveSchema.parse(await object.json());
			if (record.phase !== 'complete') throw new ConflictError('Move is not complete');
			if (!record.search_refreshed)
				await cas.put(key, JSON.stringify({ ...record, search_refreshed: true }), {
					onlyIfEtagMatches: object.etag,
				});
		});
	}
	return movedNotebookMeta(move);
}

export interface NotebookMoveContext {
	sourceProject: Project;
	destinationProject: Project;
	notebook: NotebookMeta;
	source: Source;
	repositories: { repo: string; provider: string | null }[];
}
interface MoveOwners {
	notebooks: NotebookService;
	sessions: SessionService;
	jobs: JobsService;
	jobRuns: JobRunService;
	proposals: NotebookProposalService;
	previews: NotebookPreviewService;
	deepLinks: DeepLinkService;
}

export class NotebookMoveService {
	constructor(
		private readonly bucket: Bucket,
		private readonly catalog: CatalogService,
		private readonly owners: MoveOwners,
	) {}

	/** Offline recovery retains unfinished move fences; the original request resumes the transfer. */
	static async recover(bucket: Bucket, options: { writersStopped: true }) {
		if (!options.writersStopped) throw new ValidationError('Stop all writers before recovery');
		await NotebookMutationGate.clearAbandonedWriters(bucket, options);
		const pending = [];
		for (const object of await listAllObjects(bucket, paths.notebookMoves)) {
			const move = await withCasRetry(bucket, async (cas) => {
				const record = await bucket.get(object.key);
				if (!record) return;
				const move = NotebookMoveSchema.parse(await record.json());
				await cas.put(object.key, JSON.stringify({ ...move, executor: null }), {
					onlyIfEtagMatches: record.etag,
				});
				return move;
			});
			if (move?.phase === 'complete') await releaseCompletedMove(bucket, move);
			if (move && move.phase !== 'complete')
				pending.push({
					source: move.source,
					destination: move.destination,
					notebook_id: move.notebook_id,
					actor: move.actor,
					idempotency_key: move.idempotency_key,
					expected_version: move.meta.updated_at,
				});
		}
		return pending;
	}

	private async context(
		source: ProjectId,
		destination: ProjectId,
		nid: NotebookId,
		previous?: Move,
	): Promise<NotebookMoveContext> {
		const from = await this.bucket.get(paths.project(source).meta);
		const to = await this.bucket.get(paths.project(destination).meta);
		if (!from || !to) throw new NotFoundError('Project not found');
		const metaObject = await this.bucket.get(
			paths.project(previous?.phase === 'complete' ? destination : source).notebook(nid).meta,
		);
		let meta =
			previous?.phase === 'copying' || previous?.phase === 'published' ? previous.meta : undefined;
		if (!meta && metaObject)
			meta = await readStored(NotebookMetaSchema, metaObject, metaObject.key);
		if (!meta) throw new NotFoundError('Notebook not found');
		let sourceRecord = previous?.source_record;
		if (!sourceRecord || previous?.phase === 'preparing') {
			if (!previous) await new NotebookMutationGate(this.bucket).assertReadable(source, nid);
			const sourceObject = await this.bucket.get(paths.project(source).notebook(nid).source);
			if (!sourceObject) throw new NotFoundError('Notebook source not found');
			sourceRecord = await readStored(SourceSchema, sourceObject, sourceObject.key);
		}
		if (meta.preview || meta.status === 'deleted') throw new NotFoundError('Notebook not found');
		const repositories: NotebookMoveContext['repositories'] =
			sourceRecord.type === 'git'
				? [
						{ repo: sourceRecord.repo, provider: sourceRecord.provider },
						...(sourceRecord.pending_config
							? [{ repo: sourceRecord.pending_config.repo, provider: sourceRecord.provider }]
							: []),
					]
				: [];
		if (!previous || previous.phase === 'preparing' || previous.phase === 'copying') {
			for (const entry of (await this.owners.previews.store.project(source)).entries) {
				if (entry.intent.notebook_id === nid)
					repositories.push({ repo: entry.intent.repository, provider: null });
			}
			for (const version of await this.owners.notebooks.listVersions(source, nid))
				if (version.git_source) repositories.push(version.git_source);
			for (const object of await listAllObjects(
				this.bucket,
				`${paths.project(source).notebook(nid).base}/proposals/`,
			)) {
				if (!object.key.endsWith('/proposal.json')) continue;
				const record = await this.bucket.get(object.key);
				if (record)
					repositories.push(
						z
							.object({ source: z.object({ repo: z.string(), provider: z.string().nullable() }) })
							.parse(await record.json()).source,
					);
			}
		}
		return {
			sourceProject: await readStored(ProjectSchema, from, from.key),
			destinationProject: await readStored(ProjectSchema, to, to.key),
			notebook: meta,
			source: sourceRecord,
			repositories,
		};
	}

	private async assertDestinationEmpty(
		pid: ProjectId,
		nid: NotebookId,
		message: string,
	): Promise<void> {
		const objects = await this.bucket.list({
			prefix: `${paths.project(pid).notebook(nid).base}/`,
			limit: 1,
		});
		if (objects.objects.length > 0) throw new ConflictError(message);
	}

	async move(input: {
		source: ProjectId;
		destination: ProjectId;
		notebookId: NotebookId;
		actor: UserId;
		idempotencyKey: string;
		expectedVersion?: string;
		authorize: (context: NotebookMoveContext) => Promise<void>;
		reclaimSnapshot?: (snapshot: FsSnapshot) => Promise<void>;
	}): Promise<NotebookMeta> {
		if (input.source === input.destination)
			throw new ConflictError('Choose a different destination project');
		const id = await sha256Hex(
			JSON.stringify([input.actor, input.source, input.notebookId, input.idempotencyKey]),
		);
		const key = paths.notebookMove(id);
		const object = await this.bucket.get(key);
		let move = object ? NotebookMoveSchema.parse(await object.json()) : undefined;
		if (move && move.destination !== input.destination)
			throw new ConflictError('Idempotency key was used for a different destination');
		const context = await this.context(input.source, input.destination, input.notebookId, move);
		await input.authorize(context);
		const gate = new NotebookMutationGate(this.bucket);
		if (move?.phase === 'complete') return releaseCompletedMove(this.bucket, move);
		assertVersionMatch(context.notebook.updated_at, input.expectedVersion);
		const executor = crypto.randomUUID();
		move = await withCasRetry(this.bucket, async (cas) => {
			const current = await this.bucket.get(key);
			const record: Move = current
				? NotebookMoveSchema.parse(await current.json())
				: {
						schema_version: 1,
						id,
						idempotency_key: input.idempotencyKey,
						source: input.source,
						destination: input.destination,
						notebook_id: input.notebookId,
						actor: input.actor,
						updated_at: new Date().toISOString(),
						phase: 'preparing',
						executor: null,
						runtimes: [],
						snapshots: [],
						search_refreshed: false,
						meta: context.notebook,
						source_record: context.source,
					};
			if (record.phase === 'complete')
				throw new ConflictError('Move completed. Retry to read its result');
			if (record.executor) throw new ConflictError('This move is already running');
			if (record.destination !== input.destination)
				throw new ConflictError('Idempotency key was used for a different destination');
			const next = {
				...record,
				...(record.phase === 'preparing'
					? {
							meta: context.notebook,
							source_record: context.source,
							updated_at: new Date().toISOString(),
						}
					: {}),
				executor,
			};
			await cas.put(
				key,
				JSON.stringify(next),
				current ? { onlyIfEtagMatches: current.etag } : { onlyIfNotExists: true },
			);
			return next;
		});
		const save = async (patch: Partial<Move>) => {
			move = await withCasRetry(this.bucket, async (cas) => {
				const current = await this.bucket.get(key);
				if (!current) throw new ConflictError('Move record is missing');
				const record = NotebookMoveSchema.parse(await current.json());
				if (record.executor !== executor) throw new ConflictError('Move ownership changed');
				const next = { ...record, ...patch };
				await cas.put(key, JSON.stringify(next), { onlyIfEtagMatches: current.etag });
				return next;
			});
		};
		let releaseOnFailure = move.phase === 'preparing';
		try {
			const { source, destination, notebook_id: nid } = move;
			const pools = new AppPoolStore(this.bucket);
			const uploads = new ResumableUploads(
				this.bucket,
				`${paths.project(source).notebook(nid).base}/uploads/`,
			);
			for (const pid of [source, destination].sort()) await gate.claim(pid, nid, id);
			if (move.phase === 'preparing') {
				const fresh = await this.bucket.get(paths.project(source).notebook(nid).meta);
				if (!fresh) throw new NotFoundError('Notebook not found');
				const freshMeta = await readStored(NotebookMetaSchema, fresh, fresh.key);
				assertVersionMatch(freshMeta.updated_at, move.meta.updated_at);
				if (JSON.stringify(freshMeta) !== JSON.stringify(move.meta))
					throw new ConflictError('Notebook changed. Start a new move.');
				await this.assertDestinationEmpty(
					destination,
					nid,
					'Destination already contains this notebook',
				);
				const entries = (await this.owners.previews.store.project(source)).entries.filter(
					(entry) => entry.intent.notebook_id === nid,
				);
				const runtimes = entries.flatMap((entry) =>
					entry.artifacts.map((artifact) => artifact.notebook_id),
				);
				await save({ runtimes });
				for (const runtime of runtimes) {
					await gate.claim(source, runtime, id);
					await gate.claim(destination, runtime, id);
					await this.assertDestinationEmpty(
						destination,
						runtime,
						'Destination already contains a preview runtime',
					);
				}
				const snapshots: FsSnapshot[] = [];
				for (const id of [nid, ...runtimes]) {
					const object = await this.bucket.get(paths.project(source).notebook(id).fsSnapshot);
					if (object) snapshots.push(await readStored(FsSnapshotSchema, object, object.key));
				}
				if (snapshots.length > 0 && !input.reclaimSnapshot)
					throw new ConflictError('Filesystem snapshot cleanup is unavailable');
				await save({ runtimes, snapshots });
				const ids = new Set([nid, ...runtimes]);
				for (const id of ids) {
					await this.owners.jobs.assertReadyForMove(source, id);
					if (
						(await pools.read(source, id))?.members.length ||
						(await pools.read(destination, id))?.members.length
					)
						throw new ConflictError('Wait for app pool cleanup before moving');
				}
				await this.owners.sessions.assertReadyForMove(source, ids);
				const activeRuns = await this.owners.jobRuns.listActiveSnapshot();
				if (
					!activeRuns.complete ||
					activeRuns.entries.some(
						({ marker }) => marker.project_id === source && ids.has(marker.notebook_id),
					)
				)
					throw new ConflictError('Wait for notebook jobs and their finalization before moving');
				for (const entry of entries) {
					const record = await this.owners.previews.get(source, nid, entry.intent.id);
					if (
						record.preparation === 'preparing' ||
						record.preparation === 'pending' ||
						record.state !== 'active' ||
						record.admissions.length > 0
					)
						throw new ConflictError('Wait for preview preparation or cleanup before moving');
				}
				await uploads.assertReadyForMove();
				const currentSource = await this.bucket.get(paths.project(source).notebook(nid).source);
				if (
					!currentSource ||
					JSON.stringify(SourceSchema.parse(await currentSource.json())) !==
						JSON.stringify(move.source_record)
				)
					throw new ConflictError('Notebook source changed. Start a new move.');
				await input.authorize(await this.context(source, destination, nid, move));
				// A failed response cannot prove that the phase write did not commit.
				releaseOnFailure = false;
				await save({ phase: 'copying' });
			}
			if (move.phase === 'copying') {
				for (const notebookId of [nid, ...move.runtimes]) {
					await pools.freezeForMove(source, notebookId);
					await pools.freezeForMove(destination, notebookId);
				}
				await this.owners.notebooks.copyForMove(source, destination, nid, move.updated_at);
				await this.owners.notebooks.thumbnails.copyForMove(source, destination, nid);
				await uploads.copyForMove(`${paths.project(destination).notebook(nid).base}/uploads/`);
				await this.owners.jobs.copyForMove(source, destination, nid);
				await this.owners.jobRuns.copyForMove(source, destination, nid);
				await this.owners.proposals.copyForMove(source, destination, nid);
				await this.owners.sessions.copyPruneCutoffForMove(source, destination, nid);
				await this.owners.previews.copyForMove(source, destination, nid, move.updated_at);
				await input.authorize(await this.context(source, destination, nid, move));
				const publishing = move;
				const movedJobs = (await this.owners.jobs.listJobs(source, nid)).map(jobIndexEntry);
				await this.catalog.mutateSnapshot(
					'notebook.move',
					input.actor,
					(snapshot) => {
						const from = snapshot.projects.find((project) => project.id === source);
						const to = snapshot.projects.find((project) => project.id === destination);
						if (!from || !to || from.status === 'deleted' || to.status === 'deleted')
							throw new NotFoundError('Project not found');
						const notebook = from.notebooks.find((entry) => entry.id === nid);
						if (!notebook && to.notebooks.some((entry) => entry.id === nid && entry.move_id === id))
							return snapshot;
						if (!notebook || notebook.status === 'deleted')
							throw new NotFoundError('Notebook not found');
						if (to.notebooks.some((entry) => entry.id === nid))
							throw new ConflictError('Notebook already exists in destination');
						const movedEntry = {
							...notebook,
							...buildNotebookEntry(
								movedNotebookMeta(publishing),
								publishing.source_record.type,
								paths.project(destination).notebook(nid).base,
								UserIdValue.parse(publishing.meta.author),
							),
							jobs: movedJobs,
							security_labels_pending: undefined,
							move_id: id,
						};
						return {
							...snapshot,
							projects: snapshot.projects.map((project) => {
								if (project.id !== source && project.id !== destination) return project;
								const leaving = project.id === source;
								return {
									...project,
									notebooks: leaving
										? project.notebooks.filter((entry) => entry.id !== nid)
										: [...project.notebooks, movedEntry],
									notebook_count: project.notebook_count + (leaving ? -1 : 1),
									updated_at: publishing.updated_at,
								};
							}),
						};
					},
					{
						project_id: source,
						destination_project_id: destination,
						notebook_id: nid,
						move_id: id,
					},
				);
				await save({ phase: 'published' });
			}
			await this.owners.deepLinks.moveNotebook(source, destination, nid);
			for (const notebookId of [nid, ...move.runtimes]) {
				await pools.finishNotebookMove(source, destination, notebookId);
				await this.owners.sessions.finishNotebookMove(source, notebookId);
			}
			await new EventService(this.bucket).append(
				{
					event: 'notebook.move.received',
					actor: input.actor,
					project_id: destination,
					source_project_id: source,
					notebook_id: nid,
					move_id: id,
				},
				{ id: `notebook-move:${id}:destination`, timestamp: move.updated_at, onlyIfAbsent: true },
			);
			await this.owners.previews.finishMove(source, nid);
			for (const notebookId of [nid, ...move.runtimes])
				await this.owners.notebooks.removeMovedObjects(source, notebookId);
			await this.owners.proposals.finishMove(source, nid);
			for (const snapshot of move.snapshots) await input.reclaimSnapshot!(snapshot);
			await save({ phase: 'complete', executor: null });
			return await releaseCompletedMove(this.bucket, move);
		} catch (error) {
			if (releaseOnFailure) {
				for (const nid of [move.notebook_id, ...move.runtimes]) {
					await gate.release(move.source, nid, id);
					await gate.release(move.destination, nid, id);
				}
			}
			if (move.executor === executor) await save({ executor: null });
			throw error;
		}
	}
}
