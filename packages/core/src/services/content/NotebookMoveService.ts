import { buildNotebookEntry } from './notebookMeta';
import { jobIndexEntry } from '../jobs/JobsService';
import { SYSTEM_ACTOR, UserId as UserIdValue } from '../../ids';
import { ResumableUploads } from './ResumableUploads';
import { AppPoolStore } from '../runtime/AppPoolStore';
import { EventService } from '../catalog/EventService';
import { nextIsoTimestamp } from '../../utcDate';
import type { Bucket } from '../../ports/bucket';
import type { NotebookId, ProjectId, UserId } from '../../ids';
import { ConflictError, NotFoundError, assertVersionMatch } from '../../errors';
import { ulid } from 'ulidx';
import { paths } from '../../paths';
import {
	NotebookMetaSchema,
	NotebookProposalSchema,
	ProjectSchema,
	SourceSchema,
	FsSnapshotSchema,
	readStored,
} from '../../schema';
import type {
	NotebookMeta,
	Project,
	Source,
	FsSnapshot,
	Snapshot,
	SnapshotNotebookEntry,
} from '../../schema';
import type { CatalogService } from '../catalog/CatalogService';
import { deleteByPrefix, listAllObjects } from '../catalog/storage';
import { withCasRetry } from '../catalog/cas';
import { NOTEBOOK_MOVE_LEASE_MS, readNotebookMove } from './notebookMoveRecord';
import type { NotebookMove } from './notebookMoveRecord';
import type { NotebookService } from './NotebookService';
import type { SessionService } from '../runtime/SessionService';
import type { JobsService } from '../jobs/JobsService';
import type { JobRunService } from '../jobs/JobRunService';
import type { NotebookProposalService } from './NotebookProposalService';
import type { NotebookPreviewService } from './NotebookPreviewService';
import type { DeepLinkService } from './DeepLinkService';

export { NotebookMoveSchema } from './notebookMoveRecord';

function movedNotebookMeta(move: NotebookMove): NotebookMeta {
	const { move_id: _moving, ...meta } = move.meta;
	return { ...meta, project_id: move.destination, updated_at: move.updated_at };
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
interface MoveInput {
	source: ProjectId;
	destination: ProjectId;
	notebookId: NotebookId;
	actor: UserId;
	expectedVersion?: string;
	authorize: (context: NotebookMoveContext) => Promise<void>;
	reclaimSnapshot?: (snapshot: FsSnapshot) => Promise<void>;
}

/**
 * Moves a notebook between projects with one record per notebook at
 * `_system/notebook-moves/{nid}.json`. The source metadata carries `move_id` from fencing until
 * cleanup, which makes the notebook unreadable and unwritable without any extra request on
 * ordinary paths. A move that loses its executor is resumed by posting the same request again
 * once the lease expires; a move that cannot finish before publication can be cancelled.
 */
export class NotebookMoveService {
	constructor(
		private readonly bucket: Bucket,
		private readonly catalog: CatalogService,
		private readonly owners: MoveOwners,
	) {}

	private metaKeys(pid: ProjectId, nid: NotebookId) {
		const nb = paths.project(pid).notebook(nid);
		return [nb.meta, nb.previewMeta];
	}

	private async readMeta(pid: ProjectId, nid: NotebookId) {
		for (const key of this.metaKeys(pid, nid)) {
			const object = await this.bucket.get(key);
			if (object)
				return { key, etag: object.etag, meta: await readStored(NotebookMetaSchema, object, key) };
		}
		return null;
	}

	private async context(
		source: ProjectId,
		destination: ProjectId,
		nid: NotebookId,
		previous: NotebookMove | null,
	): Promise<NotebookMoveContext> {
		const from = await this.bucket.get(paths.project(source).meta);
		const to = await this.bucket.get(paths.project(destination).meta);
		if (!from || !to) throw new NotFoundError('Project not found');
		const inTransit = previous?.phase === 'copying' || previous?.phase === 'published';
		let meta = inTransit ? previous.meta : undefined;
		if (!meta) {
			// Replays authorize against the live destination record, not the captured one.
			const stored = await this.readMeta(
				previous?.phase === 'complete' ? destination : source,
				nid,
			);
			if (!stored) throw new NotFoundError('Notebook not found');
			if (stored.meta.move_id && stored.meta.move_id !== previous?.id)
				throw new ConflictError(
					previous
						? 'Another move of this notebook is in progress'
						: 'The notebook carries a fence from a lost move. Cancel the move to repair it.',
				);
			meta = stored.meta;
		}
		if (meta.preview || meta.status === 'deleted') throw new NotFoundError('Notebook not found');
		let sourceRecord = previous?.source_record;
		if (!sourceRecord || previous?.phase === 'preparing') {
			const sourceObject = await this.bucket.get(paths.project(source).notebook(nid).source);
			if (!sourceObject) throw new NotFoundError('Notebook source not found');
			sourceRecord = await readStored(SourceSchema, sourceObject, sourceObject.key);
		}
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
						(await readStored(NotebookProposalSchema.pick({ source: true }), record, object.key))
							.source,
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

	/** Stamps `move_id` into the metadata so readers and writers stop at the record. */
	private async fence(
		pid: ProjectId,
		move: NotebookMove,
		nid: NotebookId,
		expected?: NotebookMeta,
	): Promise<void> {
		await withCasRetry(this.bucket, async (cas) => {
			const stored = await this.readMeta(pid, nid);
			if (!stored) throw new NotFoundError('Notebook not found');
			const { move_id: fencedBy, ...current } = stored.meta;
			if (fencedBy && fencedBy !== move.id)
				throw new ConflictError('Another move of this notebook is in progress');
			// The same CAS that stamps the fence proves nothing changed since capture.
			if (expected && JSON.stringify(current) !== JSON.stringify(expected))
				throw new ConflictError('Notebook changed. Start a new move.');
			if (fencedBy) return;
			await cas.put(stored.key, JSON.stringify({ ...stored.meta, move_id: move.id }), {
				onlyIfEtagMatches: stored.etag,
			});
		});
	}

	/**
	 * Sets (`destination`) or clears (`null`) the source catalog entry's `moving` stamp for this
	 * move. Lists read it from the snapshot they already hold; only move steps pay for it.
	 */
	private async stampCatalog(
		pid: ProjectId,
		nid: NotebookId,
		moveId: string,
		destination: ProjectId | null,
		actor: UserId,
	): Promise<void> {
		const settled = (entry: SnapshotNotebookEntry | undefined) =>
			!entry || (destination ? entry.moving?.move_id === moveId : entry.moving?.move_id !== moveId);
		const entryIn = (snapshot: Snapshot) =>
			snapshot.projects
				.find((project) => project.id === pid)
				?.notebooks.find((entry) => entry.id === nid);
		if (settled(entryIn(await this.catalog.getCurrentSnapshot()))) return;
		await this.catalog.updateNotebookEntry(
			destination ? 'notebook.move.fence' : 'notebook.move.release',
			actor,
			pid,
			nid,
			(entry) =>
				settled(entry)
					? undefined
					: {
							moving: destination
								? { move_id: moveId, destination_project_id: destination }
								: undefined,
						},
			undefined,
			{ project_id: pid, notebook_id: nid, move_id: moveId },
		);
	}

	private async unfence(pid: ProjectId, moveId: string, nid: NotebookId): Promise<void> {
		await withCasRetry(this.bucket, async (cas) => {
			const stored = await this.readMeta(pid, nid);
			if (stored?.meta.move_id !== moveId) return;
			const { move_id: _moving, ...meta } = stored.meta;
			await cas.put(stored.key, JSON.stringify(meta), { onlyIfEtagMatches: stored.etag });
		});
	}

	/**
	 * Takes the record's lease for this executor. A live lease held by another executor means
	 * the move is still running somewhere; an expired one is taken over.
	 */
	private async lease(
		key: string,
		executor: string,
		transfer: { source: ProjectId; destination?: ProjectId },
		create?: () => NotebookMove,
	): Promise<NotebookMove> {
		return withCasRetry(this.bucket, async (cas) => {
			const stored = await readNotebookMove(this.bucket, key);
			const pending = stored && stored.move.phase !== 'complete' ? stored.move : null;
			if (!pending && !create) throw new NotFoundError('No pending move for this notebook');
			if (
				pending &&
				(pending.source !== transfer.source ||
					(transfer.destination && pending.destination !== transfer.destination))
			)
				throw new ConflictError(
					'A move of this notebook to another project is in progress. Finish or cancel it first.',
				);
			const record = pending ?? create!();
			if (
				record.lease &&
				record.lease.executor !== executor &&
				record.lease.expires_at > Date.now()
			)
				throw new ConflictError('This move is already running. Retry after it finishes.');
			const next: NotebookMove = {
				...record,
				lease: { executor, expires_at: Date.now() + NOTEBOOK_MOVE_LEASE_MS },
			};
			await cas.put(
				key,
				JSON.stringify(next),
				stored ? { onlyIfEtagMatches: stored.etag } : { onlyIfNotExists: true },
			);
			return next;
		});
	}

	private async runLeased<T>(
		key: string,
		executor: string,
		work: (save: (patch: Partial<NotebookMove>) => Promise<NotebookMove>) => Promise<T>,
	): Promise<T> {
		let lost = false;
		const save = (patch: Partial<NotebookMove>) =>
			withCasRetry(this.bucket, async (cas) => {
				const stored = await readNotebookMove(this.bucket, key);
				if (lost || !stored || stored.move.lease?.executor !== executor) {
					lost = true;
					throw new ConflictError('Move ownership changed');
				}
				const next: NotebookMove = {
					...stored.move,
					...patch,
					lease:
						patch.lease === null
							? null
							: { executor, expires_at: Date.now() + NOTEBOOK_MOVE_LEASE_MS },
				};
				await cas.put(key, JSON.stringify(next), { onlyIfEtagMatches: stored.etag });
				return next;
			});
		const renewal = setInterval(() => {
			void save({}).catch(() => {
				lost = true;
			});
		}, NOTEBOOK_MOVE_LEASE_MS / 3);
		try {
			return await work(save);
		} finally {
			clearInterval(renewal);
		}
	}

	async move(input: MoveInput): Promise<NotebookMeta> {
		const { source, destination, notebookId: nid } = input;
		if (source === destination) throw new ConflictError('Choose a different destination project');
		const key = paths.notebookMove(nid);
		const existing = (await readNotebookMove(this.bucket, key))?.move ?? null;
		const replay =
			existing?.phase === 'complete' &&
			existing.source === source &&
			existing.destination === destination;
		const pending = existing && existing.phase !== 'complete' ? existing : null;
		if (pending && (pending.source !== source || pending.destination !== destination))
			throw new ConflictError(
				'A move of this notebook to another project is in progress. Finish or cancel it first.',
			);
		const previous = replay ? existing : pending;
		const context = await this.context(source, destination, nid, previous);
		await input.authorize(context);
		if (context.source.type === 'git' && context.source.working_branch) {
			throw new ConflictError('Working branch notebooks cannot move between projects');
		}
		if (replay) {
			await this.owners.notebooks.pruneVersionsAfterMove(destination, nid);
			return movedNotebookMeta(existing);
		}
		assertVersionMatch(context.notebook.updated_at, input.expectedVersion);

		const executor = crypto.randomUUID();
		let move = await this.lease(key, executor, { source, destination }, () => ({
			schema_version: 1,
			id: ulid(),
			notebook_id: nid,
			source,
			destination,
			actor: input.actor,
			updated_at: nextIsoTimestamp(context.notebook.updated_at, new Date().toISOString()),
			phase: 'preparing',
			lease: null,
			runtimes: [],
			snapshots: [],
			meta: context.notebook,
			source_record: context.source,
		}));
		return this.runLeased(key, executor, async (save) => {
			const pools = new AppPoolStore(this.bucket);
			const uploads = new ResumableUploads(
				this.bucket,
				`${paths.project(source).notebook(nid).base}/uploads/`,
			);
			try {
				if (move.phase === 'preparing') {
					const fresh = await this.readMeta(source, nid);
					if (!fresh) throw new NotFoundError('Notebook not found');
					const { move_id: fencedBy, ...freshMeta } = fresh.meta;
					if (fencedBy && fencedBy !== move.id)
						throw new ConflictError('Another move of this notebook is in progress');
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
					for (const runtime of runtimes)
						await this.assertDestinationEmpty(
							destination,
							runtime,
							'Destination already contains a preview runtime',
						);
					const snapshots: FsSnapshot[] = [];
					for (const id of [nid, ...runtimes]) {
						const object = await this.bucket.get(paths.project(source).notebook(id).fsSnapshot);
						if (object) snapshots.push(await readStored(FsSnapshotSchema, object, object.key));
					}
					if (snapshots.length > 0 && !input.reclaimSnapshot)
						throw new ConflictError('Filesystem snapshot cleanup is unavailable');
					move = await save({ runtimes, snapshots });
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
					await this.assertNoActiveRuns(source, ids);
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
					await this.owners.previews.store.assertMoveCapacity(source, destination, nid);
					const currentSource = await this.bucket.get(paths.project(source).notebook(nid).source);
					if (
						!currentSource ||
						JSON.stringify(SourceSchema.parse(await currentSource.json())) !==
							JSON.stringify(move.source_record)
					)
						throw new ConflictError('Notebook source changed. Start a new move.');
					await input.authorize(await this.context(source, destination, nid, move));
					for (const id of ids)
						await this.fence(source, move, id, id === nid ? move.meta : undefined);
					await this.stampCatalog(source, nid, move.id, destination, input.actor);
					// Writers admitted before the fence may still hold the workspace mutation
					// lease or a job operation claim; taking each once lets them finish before
					// anything is copied. A session admitted in the same window is refused here.
					await this.owners.notebooks.workspace.withMutation(source, nid, {}, async () => {});
					for (const id of ids)
						await this.owners.jobRuns.waitForJobMutations(source, id, { strict: true });
					await this.owners.sessions.assertReadyForMove(source, ids);
					// Runtimes were captured before the fence. A preparation reserves its runtime
					// before it reads the parent, so one that can still write is visible here.
					const reserved = await this.owners.previews.runtimesForMove(source, nid);
					if (reserved.some((id) => !ids.has(id)))
						throw new ConflictError('Wait for preview preparation or cleanup before moving');
					move = await save({ phase: 'copying' });
				}
			} catch (error) {
				// Nothing has been copied yet, so the notebook can be released unless another
				// executor has already taken the move over.
				if (
					await save({}).then(
						() => true,
						() => false,
					)
				)
					await this.release(move);
				throw error;
			}
			try {
				if (move.phase === 'copying') {
					for (const notebookId of [nid, ...move.runtimes]) {
						await pools.freezeForMove(source, notebookId);
						await pools.freezeForMove(destination, notebookId);
					}
					// Copies carry the fence too, so the destination stays unreadable until published.
					await this.owners.notebooks.copyForMove(
						source,
						destination,
						nid,
						move.updated_at,
						move.id,
					);
					await this.owners.notebooks.thumbnails.copyForMove(source, destination, nid);
					await uploads.copyForMove(`${paths.project(destination).notebook(nid).base}/uploads/`);
					await this.owners.jobs.copyForMove(source, destination, nid);
					await this.owners.jobRuns.copyForMove(source, destination, nid);
					await this.owners.proposals.copyForMove(source, destination, nid);
					await this.owners.sessions.copyPruneCutoffForMove(source, destination, nid);
					await this.owners.previews.copyForMove(
						source,
						destination,
						nid,
						move.runtimes,
						move.updated_at,
						move.id,
					);
					await input.authorize(await this.context(source, destination, nid, move));
					// A run admitted after preflight would write outputs into the source.
					await this.assertNoActiveRuns(source, new Set([nid, ...move.runtimes]));
					// A cancelled or taken-over move must not reach the catalog.
					await save({});
					await this.assertSourceMetaUnchanged(move);
					await this.publish(move, input.actor);
					move = await save({ phase: 'published' });
				}
				for (const notebookId of [nid, ...move.runtimes])
					await this.unfence(destination, move.id, notebookId);
				await this.owners.deepLinks.moveNotebook(source, destination, nid);
				for (const notebookId of [nid, ...move.runtimes]) {
					await pools.finishNotebookMove(source, destination, notebookId);
					await this.owners.sessions.finishNotebookMove(source, notebookId);
					await this.owners.jobRuns.finishMove(source, notebookId);
				}
				await new EventService(this.bucket).append(
					{
						event: 'notebook.move.received',
						actor: input.actor,
						project_id: destination,
						source_project_id: source,
						notebook_id: nid,
						move_id: move.id,
					},
					{
						id: `notebook-move:${move.id}:destination`,
						timestamp: move.updated_at,
						onlyIfAbsent: true,
					},
				);
				await this.owners.previews.finishMove(source, nid);
				await save({});
				for (const notebookId of [nid, ...move.runtimes])
					await this.owners.notebooks.removeMovedObjects(source, notebookId);
				await this.owners.proposals.finishMove(source, nid);
				for (const snapshot of move.snapshots) await input.reclaimSnapshot!(snapshot);
				move = await save({ phase: 'complete', lease: null });
				// Queued saves still prune the source project, not these copied versions.
				await this.owners.notebooks.pruneVersionsAfterMove(destination, nid);
				return movedNotebookMeta(move);
			} catch (error) {
				// Drop the lease so a retry can resume at once instead of waiting for expiry.
				await save({ lease: null }).catch(() => {});
				throw error;
			}
		});
	}

	/**
	 * Abandons a move that has not been published: destination copies are removed and the
	 * source notebook becomes readable again. A running executor must finish or expire first.
	 * `authorize` sees the source project and the source notebook metadata (fenced or not)
	 * before anything is written.
	 */
	async cancel(
		input: { source: ProjectId; notebookId: NotebookId },
		authorize: (context: { sourceProject: Project; notebook: NotebookMeta }) => Promise<void>,
	): Promise<void> {
		const key = paths.notebookMove(input.notebookId);
		const existing = (await readNotebookMove(this.bucket, key))?.move;
		const pending =
			existing && existing.phase !== 'complete' && existing.source === input.source
				? existing
				: null;
		const stored = await this.readMeta(input.source, input.notebookId);
		// A fence without a record cannot belong to a live move; clearing it is the repair.
		const orphanedFence =
			!pending && stored?.meta.move_id && stored.meta.move_id !== existing?.id
				? stored.meta.move_id
				: null;
		if (!pending && !orphanedFence) throw new NotFoundError('No pending move for this notebook');
		const projectObject = await this.bucket.get(paths.project(input.source).meta);
		if (!projectObject) throw new NotFoundError('Project not found');
		await authorize({
			sourceProject: await readStored(ProjectSchema, projectObject, projectObject.key),
			// Source metadata is removed only after publication, which cancel refuses anyway.
			notebook: stored?.meta ?? pending!.meta,
		});
		if (orphanedFence) {
			await this.unfence(input.source, orphanedFence, input.notebookId);
			await this.stampCatalog(input.source, input.notebookId, orphanedFence, null, SYSTEM_ACTOR);
			return;
		}
		const executor = crypto.randomUUID();
		const move = await this.lease(key, executor, { source: input.source });
		await this.runLeased(key, executor, async () => {
			const { source, destination, notebook_id: nid } = move;
			if (move.phase === 'published' || (await this.isPublished(move)))
				throw new ConflictError('The move has been published. Retry it to finish cleanup.');
			const pools = new AppPoolStore(this.bucket);
			for (const notebookId of [nid, ...move.runtimes]) {
				await deleteByPrefix(
					this.bucket,
					`${paths.project(destination).notebook(notebookId).base}/`,
				);
				await pools.cancelNotebookMove(source, notebookId);
				await this.bucket.delete([paths.versionPruneCutoff(destination, notebookId)]);
			}
			await this.owners.previews.finishMove(destination, nid);
			await this.owners.proposals.finishMove(destination, nid);
			await this.release(move);
		}).catch(async (error: unknown) => {
			await this.dropLease(key, executor);
			throw error;
		});
	}

	private async dropLease(key: string, executor: string): Promise<void> {
		await withCasRetry(this.bucket, async (cas) => {
			const stored = await readNotebookMove(this.bucket, key);
			if (!stored || stored.move.lease?.executor !== executor) return;
			await cas.put(key, JSON.stringify({ ...stored.move, lease: null }), {
				onlyIfEtagMatches: stored.etag,
			});
		}).catch(() => {});
	}

	/** The catalog is the source of truth when a publication's response was lost. */
	private async isPublished(move: NotebookMove): Promise<boolean> {
		const snapshot = await this.catalog.getCurrentSnapshot();
		return (
			snapshot.projects
				.find((project) => project.id === move.destination)
				?.notebooks.some((entry) => entry.id === move.notebook_id && entry.move_id === move.id) ??
			false
		);
	}

	private async release(move: NotebookMove): Promise<void> {
		for (const id of [move.notebook_id, ...move.runtimes])
			await this.unfence(move.source, move.id, id);
		// Cleared before the record goes, so a crash leaves a stamp only beside a cancellable record.
		await this.stampCatalog(move.source, move.notebook_id, move.id, null, move.actor);
		await this.bucket.delete([paths.notebookMove(move.notebook_id)]);
	}

	/**
	 * Proves no writer slipped past the fence before the captured copy is published. `source.json`
	 * carries no fence, so a writer that checked the metadata just before fencing can still land.
	 */
	private async assertSourceMetaUnchanged(move: NotebookMove): Promise<void> {
		const stored = await this.readMeta(move.source, move.notebook_id);
		const { move_id: fencedBy, ...current } = stored?.meta ?? {};
		const sourceObject = await this.bucket.get(
			paths.project(move.source).notebook(move.notebook_id).source,
		);
		const sourceRecord = sourceObject
			? await readStored(SourceSchema, sourceObject, sourceObject.key)
			: null;
		if (
			!stored ||
			fencedBy !== move.id ||
			JSON.stringify(current) !== JSON.stringify(move.meta) ||
			JSON.stringify(sourceRecord) !== JSON.stringify(move.source_record)
		)
			throw new ConflictError('Notebook changed. Start a new move.');
	}

	private async assertNoActiveRuns(source: ProjectId, ids: ReadonlySet<NotebookId>) {
		const activeRuns = await this.owners.jobRuns.listActiveSnapshot();
		if (
			!activeRuns.complete ||
			activeRuns.entries.some(
				({ marker }) => marker.project_id === source && ids.has(marker.notebook_id),
			)
		)
			throw new ConflictError('Wait for notebook jobs and their finalization before moving');
	}

	private async publish(move: NotebookMove, actor: UserId): Promise<void> {
		const { source, destination, notebook_id: nid, id } = move;
		const movedJobs = (await this.owners.jobs.listJobs(source, nid)).map(jobIndexEntry);
		await this.catalog.mutateSnapshot(
			'notebook.move',
			actor,
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
						movedNotebookMeta(move),
						move.source_record.type,
						paths.project(destination).notebook(nid).base,
						UserIdValue.parse(move.meta.author),
					),
					jobs: movedJobs,
					security_labels_pending: undefined,
					moving: undefined,
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
							updated_at: move.updated_at,
							search_refresh: id,
						};
					}),
				};
			},
			{ project_id: source, destination_project_id: destination, notebook_id: nid, move_id: id },
		);
	}
}
