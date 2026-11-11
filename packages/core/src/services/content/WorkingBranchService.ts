import { z } from 'zod';
import { SingleFlight } from '../../cache';
import { logEvent } from '../../logs';
import { logOperationalError } from '../../operationalLog';
import { zipSync } from 'fflate';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	UnavailableError,
	ValidationError,
} from '../../errors';
import { createNotebookId } from '../../ids';
import type { NotebookId, ProjectId, SessionId, UserId } from '../../ids';
import { sha256Hex } from '../../internal/sha256';
import { toBase64 } from '../../internal/base64url';
import { createGitSource, prepareSync } from '../../integrations/syncedSource';
import type { CreateSyncedNotebookInput } from '../../integrations/syncedSource';
import { paths } from '../../paths';
import type { Bucket } from '../../ports/bucket';
import type { SandboxInstance } from '../../ports/sandbox';
import type {
	SourceControlRegistry,
	SourceControlReader,
	WorkingBranchWriter,
	WorkingBranchInspection,
	SourceControlChange,
	SourceControlCommitIdentity,
} from '../../ports/sourceControl';
import { ProjectSchema, ProposalChangeSchema, VersionSchema, readStored } from '../../schema';
import type { GitSource, NotebookMeta, Session } from '../../schema';
import type { NotebookService } from './NotebookService';
import type { SessionService } from '../runtime/SessionService';
import { sessionPersistsEdits } from '../runtime/sessionState';
import { sandboxWorkspaceLayout } from '../runtime/workspaceLayout';
import { putIfAbsent, putIfMatch, withCasRetry } from '../catalog/cas';
import { listAllObjects } from '../catalog/storage';
import { WORKSPACE_LIMITS } from '../../integrations/remoteWorkspace';
import { captureWorkingBranchChanges } from './proposalCapture';
import { decodeProposalContent, proposalRepositoryPath, proposalSha256 } from './proposalUtils';
import {
	WorkingBranchSaveSchema,
	WorkingBranchStore,
	WORKING_BRANCH_RETENTION_MS,
	WORKING_BRANCH_DISPATCH_BOUND_MS,
	workingBranchPaths,
	WorkingBranchCreationSchema,
	WorkingBranchCaptureSchema,
	WorkingBranchCleanupSchema,
	WORKING_BRANCH_CLEANUP_KEY,
} from './workingBranchRecords';
import type {
	WorkingBranchChangeRequest,
	WorkingBranchRecord,
	WorkingBranchSave,
	WorkingBranchLease,
} from './workingBranchRecords';

const SAVE_STAGES = {
	claimed: { rank: 0, expirable: true, terminal: false, handler: 'captureSave' },
	captured: { rank: 1, expirable: true, terminal: false, handler: 'prepareSave' },
	commit_prepared: { rank: 2, expirable: true, terminal: false, handler: 'dispatchSave' },
	ref_dispatched: { rank: 3, expirable: false, terminal: false, handler: 'verifySave' },
	remote_committed: { rank: 4, expirable: false, terminal: false, handler: 'syncSave' },
	hub_synced: { rank: 5, expirable: false, terminal: false, handler: 'acknowledgeSave' },
	complete: { rank: 6, expirable: false, terminal: true, handler: null },
	no_changes: { rank: 6, expirable: false, terminal: true, handler: null },
	conflict: { rank: 6, expirable: false, terminal: true, handler: null },
	expired: { rank: 6, expirable: false, terminal: true, handler: null },
} as const satisfies Record<
	WorkingBranchSave['state'],
	{
		rank: number;
		expirable: boolean;
		terminal: boolean;
		handler: string | null;
	}
>;

type SaveOperationInput = Omit<SaveWorkingBranchInput, 'idempotencyKey' | 'sessionId'> & {
	id: string;
	sessionId?: SessionId;
	fingerprint?: string;
};
interface SaveContext {
	input: SaveOperationInput;
	source: GitSource;
	record: WorkingBranchRecord;
	reader: SourceControlReader;
	writer: WorkingBranchWriter;
	check: WorkingBranchLease;
	baselineSizes?: Map<string, number>;
	update: (
		apply: (record: WorkingBranchRecord) => WorkingBranchRecord,
	) => Promise<WorkingBranchRecord>;
	finish: (receipt: WorkingBranchSave) => Promise<WorkingBranchSave>;
}

export interface WorkingBranchDependencies {
	bucket: Bucket;
	notebooks: NotebookService;
	sessions: SessionService;
	sourceControl?: SourceControlRegistry;
}
export interface SaveWorkingBranchInput {
	projectId: ProjectId;
	notebookId: NotebookId;
	sessionId: SessionId;
	actor: UserId;
	idempotencyKey: string;
	message?: string;
	coAuthor?: SourceControlCommitIdentity;
	workdir: string;
	getSandbox: (session: Session) => SandboxInstance;
	authorize?: () => Promise<void>;
}

export class WorkingBranchService {
	private readonly store: WorkingBranchStore;
	private readonly statusRefreshes = new SingleFlight<string, WorkingBranchRecord>();
	readonly enabled: boolean;
	constructor(private readonly deps: WorkingBranchDependencies) {
		this.store = new WorkingBranchStore(deps.bucket);
		this.enabled = deps.sourceControl?.workingBranchesEnabled === true;
	}

	private provider(provider: string, repo: string, pid: ProjectId) {
		const registry = this.deps.sourceControl;
		const reader = registry?.getReader(provider, pid);
		const writer = registry?.getPublisher(provider, pid)?.workingBranches;
		if (
			!registry?.workingBranchesEnabled ||
			!reader?.supportsRepository(repo) ||
			!reader.fetchGitDirectory ||
			!writer
		) {
			throw new UnavailableError('Working branch publishing is not enabled for this repository');
		}
		return { reader, writer };
	}
	private key(value: string) {
		if (!value.trim() || value.length > 256)
			throw new BadRequestError('A valid Idempotency-Key is required');
		return value;
	}

	private async assertActiveProject(pid: ProjectId): Promise<void> {
		const key = paths.project(pid).meta;
		const object = await this.deps.bucket.get(key);
		if (!object || (await readStored(ProjectSchema, object, key)).status === 'deleted')
			throw new NotFoundError('Project not found');
	}

	async create(
		pid: ProjectId,
		actor: UserId,
		key: string,
		input: Omit<CreateSyncedNotebookInput, 'branch'> & { base_branch: string },
		authorize?: (notebook?: NotebookMeta) => Promise<void>,
	) {
		await this.assertActiveProject(pid);
		const initial = createGitSource(
			{ ...input, branch: input.base_branch, sync_mode: 'pull' },
			this.deps.sourceControl?.repositoryHosts,
		);
		if (!initial.provider) throw new BadRequestError('Unsupported repository provider');
		const { reader, writer } = this.provider(initial.provider, initial.repo, pid);
		const fingerprint = await sha256Hex(
			JSON.stringify({ ...input, repo: initial.repo, root_path: initial.root_path }),
		);
		const id = await sha256Hex(JSON.stringify([pid, actor, 'create', this.key(key)]));
		const receiptKey = `_system/working-branches/creations/${pid}/${id}.json`;
		let object = await this.deps.bucket.get(receiptKey);
		if (!object) {
			const fork = await reader.getBranchHead(initial.repo, initial.branch);
			const notebookId = createNotebookId();
			const source = {
				repo: initial.repo,
				branch: `marimohub/${pid}/${notebookId}`,
				root_path: initial.root_path,
				entry_notebook: initial.entry_notebook,
			};
			await putIfAbsent(
				this.deps.bucket,
				receiptKey,
				JSON.stringify({
					fingerprint,
					notebook_id: notebookId,
					id,
					fork_commit: fork.commit,
					source,
				}),
			);
			object = await this.deps.bucket.get(receiptKey);
		}
		if (!object) throw new UnavailableError('Working branch creation receipt is unavailable');
		const creation = await readStored(WorkingBranchCreationSchema, object, receiptKey);
		if (creation.fingerprint !== fingerprint)
			throw new ConflictError('Idempotency key was used for different notebook settings');
		const nid = creation.notebook_id;
		await this.store.create({
			schema_version: 1,
			id,
			project_id: pid,
			notebook_id: nid,
			provider: initial.provider,
			source: creation.source,
			base_branch: initial.branch,
			fork_commit: creation.fork_commit,
			created_by: actor,
			created_at: new Date().toISOString(),
			state: 'claimed',
		});
		return this.store.withLease(pid, nid, async (check, update, leased) => {
			let record = leased;
			if (record.state === 'ready') {
				const detail = await this.deps.notebooks.getNotebook(pid, nid);
				await authorize?.(detail.meta);
				return detail;
			}
			const [files, gitFiles] = await Promise.all([
				reader.fetchWorkspace(record.source.repo, record.fork_commit, record.source.root_path),
				reader.fetchGitDirectory!(record.source.repo, record.fork_commit, record.source.branch),
			]);
			prepareSync(
				{ ...initial, ...record.source },
				{ ...record.source, commit: record.fork_commit, files },
			);
			await check();
			if (record.state === 'claimed') {
				const remote = await writer.inspectBranch({
					repository: record.source.repo,
					branch: record.source.branch,
				});
				if (remote.headCommit)
					throw new ConflictError('Working branch already exists; it cannot be adopted');
				await check();
				await authorize?.();
				await this.assertActiveProject(pid);
				record = await update((current) => ({ ...current, state: 'branch_dispatched' }));
				await writer.createBranch({
					repository: record.source.repo,
					branch: record.source.branch,
					fromCommit: record.fork_commit,
				});
			} else if (record.state === 'branch_dispatched') {
				const remote = await writer.inspectBranch({
					repository: record.source.repo,
					branch: record.source.branch,
				});
				if (remote.headCommit === null) {
					await check();
					await authorize?.();
					await this.assertActiveProject(pid);
					await writer.createBranch({
						repository: record.source.repo,
						branch: record.source.branch,
						fromCommit: record.fork_commit,
					});
				} else if (remote.headCommit !== record.fork_commit)
					throw new ConflictError('The working branch no longer points to the pinned fork commit');
			}
			await check();
			await update((current) => ({ ...current, state: 'branch_created' }));
			await authorize?.();
			await this.assertActiveProject(pid);
			await this.deps.notebooks.synced.create(
				pid,
				{ ...input, ...record.source, sync_mode: 'pull' },
				actor,
				{
					notebookId: nid,
					workingBranch: {
						id,
						base_branch: record.base_branch,
						fork_commit: record.fork_commit,
						created_by: actor,
					},
				},
			);
			await check();
			const detail = await this.deps.notebooks.getNotebook(pid, nid);
			await authorize?.(detail.meta);
			await this.deps.notebooks.synced.sync(
				pid,
				nid,
				{
					...record.source,
					commit: record.fork_commit,
					files,
					git_files: gitFiles,
					expected_source_version: detail.source.current_version_id,
					working_branch_fence: { creation: id, check },
				},
				actor,
			);
			await check();
			await update((current) => ({ ...current, state: 'ready' }));
			const created = await this.deps.notebooks.getNotebook(pid, nid);
			await authorize?.(created.meta);
			return created;
		});
	}

	private async source(
		pid: ProjectId,
		nid: NotebookId,
	): Promise<{ source: GitSource; record: WorkingBranchRecord }> {
		await this.assertActiveProject(pid);
		const { meta, source } = await this.deps.notebooks.getNotebook(pid, nid);
		if (meta.status === 'deleted' || source.type !== 'git' || !source.working_branch)
			throw new NotFoundError('Working notebook not found');
		const record = await this.store.read(pid, nid);
		if (
			record.state === 'deleted' ||
			source.working_branch.id !== record.id ||
			Object.entries(record.source).some(([key, value]) => source[key as keyof GitSource] !== value)
		) {
			throw new ConflictError('Working branch source no longer matches its claim');
		}
		if (record.state !== 'ready')
			throw new ConflictError('Working notebook creation needs completion');
		return { source, record };
	}
	async status(pid: ProjectId, nid: NotebookId) {
		const found = await this.source(pid, nid);
		const { source } = found;
		let record = found.record;
		const { writer } = this.provider(record.provider, source.repo, pid);
		if (
			record.remote_commit === undefined ||
			!record.checked_at ||
			!(Date.now() - Date.parse(record.checked_at) < 60_000)
		) {
			record = await this.statusRefreshes.run(`${pid}/${nid}`, async () => {
				const remote = await writer.inspectBranch({
					repository: source.repo,
					branch: source.branch,
					changeRequestNumber: record.change_request?.number,
				});
				return this.store.update(pid, nid, (current) => ({
					...current,
					change_request: storedChangeRequest(remote) ?? current.change_request,
					ended_reason: current.ended_reason ?? branchEndedReason(remote, current.base_branch),
					remote_commit: remote.headCommit,
					checked_at:
						current.last_save === record.last_save && !current.lease
							? new Date().toISOString()
							: undefined,
				}));
			});
		}
		return {
			base_branch: record.base_branch,
			branch: source.branch,
			commit: source.commit,
			remote_commit: record.remote_commit ?? null,
			ended_reason: record.ended_reason,
			change_request: record.change_request,
			checked_at: record.checked_at,
			last_save: record.last_save ? await this.getSave(pid, nid, record.last_save) : undefined,
			active_save: record.active_save,
		};
	}
	async getSave(pid: ProjectId, nid: NotebookId, id: string): Promise<WorkingBranchSave> {
		if (!/^[a-f0-9]{64}$/.test(id)) throw new BadRequestError('Invalid save operation');
		const key = workingBranchPaths(pid, nid).save(id);
		const object = await this.deps.bucket.get(key);
		if (!object) throw new NotFoundError('Save operation not found');
		return readStored(WorkingBranchSaveSchema, object, key);
	}
	private async putSave(
		receipt: WorkingBranchSave,
		check: WorkingBranchLease,
	): Promise<WorkingBranchSave> {
		await check();
		const key = workingBranchPaths(receipt.project_id, receipt.notebook_id).save(receipt.id);
		return withCasRetry(this.deps.bucket, async (cas) => {
			const object = await this.deps.bucket.get(key);
			if (object) {
				const previous = await readStored(WorkingBranchSaveSchema, object, key);

				if (
					previous.state !== receipt.state &&
					(SAVE_STAGES[previous.state].terminal ||
						(SAVE_STAGES[previous.state].rank > SAVE_STAGES[receipt.state].rank &&
							!SAVE_STAGES[receipt.state].terminal))
				)
					throw new ConflictError('Save advanced in another request; retry to inspect its outcome');
				if (previous.commit && previous.commit !== receipt.commit)
					throw new ConflictError('Save already has a prepared commit');
			}
			await check();
			await cas.put(
				key,
				JSON.stringify(receipt),
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
			logEvent({
				event: 'working_branch.save',
				level: 'info',
				project_id: receipt.project_id,
				notebook_id: receipt.notebook_id,
				save_id: receipt.id,
				stage: receipt.state,
				commit: receipt.commit,
				changed_files: receipt.changes.length,
			});
			return receipt;
		});
	}
	async save(input: SaveWorkingBranchInput): Promise<WorkingBranchSave> {
		const id = await sha256Hex(
			JSON.stringify([
				input.projectId,
				input.notebookId,
				input.actor,
				'save',
				this.key(input.idempotencyKey),
			]),
		);
		const fingerprint = await sha256Hex(
			JSON.stringify([
				input.sessionId,
				input.message ?? 'Save notebook changes',
				input.coAuthor ? [input.coAuthor.name, input.coAuthor.email] : null,
			]),
		);
		return this.runSave({ ...input, id, fingerprint });
	}

	private async runSave(input: SaveOperationInput): Promise<WorkingBranchSave> {
		const { projectId: pid, notebookId: nid, actor, id, fingerprint } = input;
		// Source identity is pinned by the head record; only dispatch and sync re-validate the notebook.
		const { source } = await this.source(pid, nid);
		return this.store.withLease(pid, nid, async (check, update, record) => {
			const { reader, writer } = this.provider(record.provider, source.repo, pid);
			let receipt: WorkingBranchSave;
			try {
				receipt = await this.getSave(pid, nid, id);
			} catch (error) {
				if (!(error instanceof NotFoundError)) throw error;
				if (!input.sessionId || !fingerprint) throw error;
				const session = await this.editSession(pid, nid, input.sessionId);
				const versionId = session.working_branch_version_id ?? session.source_version_id;
				if (!versionId) throw new ConflictError('Session has no source baseline');
				const versionKey = paths.project(pid).notebook(nid).version(versionId).meta;
				const versionObject = await this.deps.bucket.get(versionKey);
				if (!versionObject) throw new ConflictError('Session baseline is unavailable');
				const version = await readStored(VersionSchema, versionObject, versionKey);
				if (
					!version.commit ||
					!version.git_source ||
					Object.entries(record.source).some(
						([key, value]) =>
							version.git_source?.[key as keyof typeof version.git_source] !== value,
					)
				) {
					throw new ConflictError('Session baseline belongs to another source');
				}
				receipt = {
					schema_version: 1,
					id,
					project_id: pid,
					notebook_id: nid,
					session_id: input.sessionId,
					author: actor,
					fingerprint,
					message: input.message ?? 'Save notebook changes',
					co_author: input.coAuthor,
					created_at: new Date().toISOString(),
					expires_at: new Date(Date.now() + WORKING_BRANCH_RETENTION_MS).toISOString(),
					base_version_id: versionId,
					base_commit: version.commit,
					state: 'claimed',
					changes: [],
				};
			}
			if (!fingerprint && !this.canResume(receipt, actor))
				throw new ConflictError('Only the save author can retry this operation');
			if (fingerprint && (receipt.author !== actor || receipt.fingerprint !== fingerprint))
				throw new ConflictError('Idempotency key was used for a different save');
			if (SAVE_STAGES[receipt.state].terminal) {
				await update((current) =>
					current.active_save === id ? { ...current, active_save: undefined } : current,
				);
				return receipt;
			}
			if (record.active_save && record.active_save !== id) {
				const pending = await this.getSave(pid, nid, record.active_save);
				if (
					pending.state !== 'claimed' ||
					(await this.deps.bucket.head(workingBranchPaths(pid, nid).capture(pending.id)))
				)
					throw new ConflictError('Another save needs completion or recovery first');
				await this.putSave(
					{ ...pending, state: 'conflict', error: 'Capture did not complete; start a new save.' },
					check,
				);
				await update((current) => ({ ...current, active_save: undefined }));
			}
			// Persist the receipt before exposing its ID to status and recovery readers.
			receipt = await this.putSave(receipt, check);
			await update((current) => {
				if (current.active_save && current.active_save !== id)
					throw new ConflictError('Another save needs completion or recovery first');
				return { ...current, active_save: id, last_save: id, checked_at: undefined };
			});
			const finish = async (next: WorkingBranchSave) => {
				const saved = await this.putSave(next, check);
				if (SAVE_STAGES[saved.state].terminal)
					await update((current) => ({ ...current, active_save: undefined }));
				return saved;
			};
			if (SAVE_STAGES[receipt.state].expirable && Date.parse(receipt.expires_at) <= Date.now()) {
				return finish({
					...receipt,
					state: 'expired',
					error: 'Captured source bytes expired; start a new save',
				});
			}
			const context: SaveContext = { input, source, record, reader, writer, check, update, finish };
			while (true) {
				const stage = SAVE_STAGES[receipt.state];
				if (!stage.handler) return receipt;
				const next = await this[stage.handler](receipt, context);
				// Unknown dispatches must return before reconciliation can replay the provider CAS.
				if (next.state === receipt.state || next.state === 'ref_dispatched') return next;
				receipt = next;
			}
		});
	}

	private async captureSave(
		receipt: WorkingBranchSave,
		context: SaveContext,
	): Promise<WorkingBranchSave> {
		const { input, source, check, finish } = context;
		const { projectId: pid, notebookId: nid, id } = input;
		const captureKey = workingBranchPaths(pid, nid).capture(id);
		let captured = await this.deps.bucket.get(captureKey);
		if (!captured) {
			let changes;
			try {
				const session = await this.editSession(pid, nid, receipt.session_id);
				changes = await captureWorkingBranchChanges(
					this.deps.bucket,
					input.getSandbox(session),
					sandboxWorkspaceLayout(input.workdir, source.root_path),
					paths.project(pid).notebook(nid).version(receipt.base_version_id),
					check,
				);
			} catch (error) {
				await finish({
					...receipt,
					state: 'conflict',
					error: 'Capture did not complete; start a new save.',
				});
				throw error;
			}
			context.baselineSizes = changes.baselineSizes;
			await check();
			await putIfAbsent(
				this.deps.bucket,
				captureKey,
				JSON.stringify(
					changes.changes.map(({ change, content }) => ({
						...change,
						...(content ? { content: toBase64(content) } : {}),
					})),
				),
			);
			captured = await this.deps.bucket.get(captureKey);
		}
		if (!captured) throw new UnavailableError('Save capture is unavailable');
		const manifest = z.array(ProposalChangeSchema).parse(await captured.json());
		return this.putSave({ ...receipt, state: 'captured', changes: manifest }, check);
	}

	private async validateRemoteSave(
		receipt: WorkingBranchSave,
		context: SaveContext,
	): Promise<WorkingBranchSave> {
		const { input, source, record, writer, update, finish } = context;
		await input.authorize?.();
		const remote = await writer.inspectBranch({
			repository: source.repo,
			branch: source.branch,
			changeRequestNumber: record.change_request?.number,
		});
		const ended = record.ended_reason ?? branchEndedReason(remote, record.base_branch);
		if (ended)
			await update((current) => ({ ...current, ended_reason: current.ended_reason ?? ended }));
		if (
			ended ||
			remote.headCommit !== receipt.base_commit ||
			(remote.changeRequest &&
				(remote.changeRequest.state !== 'open' ||
					remote.changeRequest.baseBranch !== record.base_branch))
		) {
			return finish({
				...receipt,
				state: 'conflict',
				error: 'BRANCH_MOVED: preserve or export your capture before restarting',
			});
		}
		return receipt;
	}

	private async validateSaveSize(
		receipt: WorkingBranchSave,
		context: SaveContext,
	): Promise<WorkingBranchSave> {
		const { finish, baselineSizes } = context;
		const { project_id: pid, notebook_id: nid } = receipt;
		if (receipt.changes.length === 0)
			return finish({ ...receipt, state: 'no_changes', commit: receipt.base_commit });
		const prefix = paths
			.project(pid)
			.notebook(nid)
			.version(receipt.base_version_id).workspacePrefix;
		const sizes = new Map(
			baselineSizes ??
				(await listAllObjects(this.deps.bucket, prefix)).map((file) => [
					file.key.slice(prefix.length),
					file.size,
				]),
		);
		for (const change of receipt.changes) {
			if (change.operation === 'delete') sizes.delete(change.path);
			else sizes.set(change.path, change.size_bytes);
		}
		if (
			sizes.size > WORKSPACE_LIMITS.maxFiles ||
			[...sizes.values()].some((size) => size > WORKSPACE_LIMITS.maxFileBytes) ||
			[...sizes.values()].reduce((total, size) => total + size, 0) > WORKSPACE_LIMITS.maxTotalBytes
		) {
			return finish({
				...receipt,
				state: 'conflict',
				error:
					'The resulting workspace exceeds import limits. Remove files or reduce their size before starting a new save; captured work remains available for recovery.',
			});
		}

		return receipt;
	}

	private async prepareSave(
		receipt: WorkingBranchSave,
		context: SaveContext,
	): Promise<WorkingBranchSave> {
		const { source, writer, check, finish } = context;
		const validated = await this.validateRemoteSave(receipt, context);
		if (SAVE_STAGES[validated.state].terminal) return validated;
		const sized = await this.validateSaveSize(receipt, context);
		if (SAVE_STAGES[sized.state].terminal) return sized;
		const changes = await this.payload(receipt, source.root_path);
		if (
			receipt.changes.some(
				(change) => change.path === source.entry_notebook && change.operation === 'delete',
			)
		) {
			return finish({
				...receipt,
				state: 'conflict',
				error: 'The notebook entry file cannot be deleted. Restore it before starting a new save.',
			});
		}
		let prepared: { commit: string };
		try {
			prepared = await writer.prepareCommit({
				repository: source.repo,
				parentCommit: receipt.base_commit,
				message: receipt.message,
				coAuthor: receipt.co_author,
				changes,
			});
		} catch (error) {
			if (!(error instanceof ConflictError)) throw error;
			return finish({
				...receipt,
				state: 'conflict',
				error:
					'Captured source conflicts with the repository tree. Export recovery or correct the files before starting a new save.',
			});
		}
		return this.putSave({ ...receipt, state: 'commit_prepared', commit: prepared.commit }, check);
	}

	private async dispatchSave(
		receipt: WorkingBranchSave,
		context: SaveContext,
	): Promise<WorkingBranchSave> {
		const { input, source, writer, check, finish } = context;
		const { projectId: pid, notebookId: nid } = input;
		const validated = await this.validateRemoteSave(receipt, context);
		if (SAVE_STAGES[validated.state].terminal) return validated;

		await input.authorize?.();
		if ((await this.source(pid, nid)).record.ended_reason) {
			return finish({
				...receipt,
				state: 'conflict',
				error: 'Working branch publication ended; captured work remains available for recovery',
			});
		}
		const dispatched = await this.putSave(
			{ ...receipt, state: 'ref_dispatched', dispatched_at: new Date(Date.now()).toISOString() },
			check,
		);
		try {
			await writer.advanceBranch({
				repository: source.repo,
				branch: source.branch,
				expectedHead: dispatched.base_commit,
				commit: dispatched.commit!,
			});
		} catch (error) {
			if (error instanceof ConflictError)
				return finish({
					...dispatched,
					state: 'conflict',
					error:
						'Remote update rejected. Check the branch head and repository rules before starting a new save; captured work is available for recovery',
				});
			return this.putSave(
				{
					...dispatched,
					error: 'Remote update outcome is unknown; retry this operation to inspect it',
				},
				check,
			);
		}
		return this.putSave({ ...dispatched, state: 'remote_committed', error: undefined }, check);
	}

	private async verifySave(
		receipt: WorkingBranchSave,
		context: SaveContext,
	): Promise<WorkingBranchSave> {
		const { input, source, record, writer, check, update, finish } = context;
		const { projectId: pid, notebookId: nid } = input;
		const remote = await writer.inspectBranch({
			repository: source.repo,
			branch: source.branch,
			commit: receipt.commit,
			changeRequestNumber: record.change_request?.number,
		});
		if (!remote.containsCommit) {
			const settled =
				Date.now() - Date.parse(receipt.dispatched_at ?? receipt.created_at) >=
				WORKING_BRANCH_DISPATCH_BOUND_MS;
			const unresolved = (error: string, settledError: string) =>
				settled
					? finish({ ...receipt, state: 'conflict', error: settledError })
					: this.putSave({ ...receipt, error }, check);
			const ended = record.ended_reason ?? branchEndedReason(remote, record.base_branch);
			if (ended)
				await update((current) => ({
					...current,
					ended_reason: current.ended_reason ?? ended,
				}));
			if (ended || remote.headCommit !== receipt.base_commit)
				return unresolved(
					'Remote update remains unresolved; preserve the capture for recovery',
					ended
						? 'Working branch publication ended before the update was confirmed; captured work remains available for recovery'
						: 'The branch moved without the saved commit; captured work remains available for recovery',
				);
			await input.authorize?.();
			if ((await this.source(pid, nid)).record.ended_reason)
				return unresolved(
					'Working branch publication ended; preserve the capture for recovery',
					'Working branch publication ended before the update was confirmed; captured work remains available for recovery',
				);
			// The retry is itself a request that may land later, so it restarts the bound unless
			// GitHub definitely rejects it.
			const retried = await this.putSave(
				{ ...receipt, dispatched_at: new Date(Date.now()).toISOString() },
				check,
			);
			try {
				await writer.advanceBranch({
					repository: source.repo,
					branch: source.branch,
					expectedHead: retried.base_commit,
					commit: retried.commit!,
				});
			} catch (error) {
				if (!(error instanceof ConflictError))
					return this.putSave(
						{
							...retried,
							error: 'Remote update remains unresolved; retry to reconcile the branch',
						},
						check,
					);
				// A rejected retry cannot rule out the earlier request still being in flight.
				return settled
					? finish({
							...retried,
							dispatched_at: receipt.dispatched_at,
							state: 'conflict',
							error:
								'Remote update rejected. Check the branch head and repository rules before starting a new save; captured work is available for recovery',
						})
					: this.putSave(
							{
								...retried,
								dispatched_at: receipt.dispatched_at,
								error: 'Remote update remains unresolved; retry to reconcile the branch',
							},
							check,
						);
			}
		}
		return this.putSave({ ...receipt, state: 'remote_committed', error: undefined }, check);
	}

	private async syncSave(
		receipt: WorkingBranchSave,
		context: SaveContext,
	): Promise<WorkingBranchSave> {
		const { input, source, record, reader, check, finish } = context;
		const { projectId: pid, notebookId: nid, actor, id } = input;
		// Authorization failures belong to this caller, not the save, so they must not end it.
		await input.authorize?.();
		try {
			const { source: current } = await this.source(pid, nid);
			if (current.commit !== receipt.base_commit && current.commit !== receipt.commit)
				return await finish({
					...receipt,
					state: 'conflict',
					error:
						'Committed remotely, but the hub source advanced. Download recovery and restart the editor before saving again.',
				});
			const [files, gitFiles] = await Promise.all([
				reader.fetchWorkspace(source.repo, receipt.commit!, source.root_path),
				reader.fetchGitDirectory!(source.repo, receipt.commit!, source.branch),
			]);
			await check();
			await this.deps.notebooks.synced.sync(
				pid,
				nid,
				{
					...record.source,
					commit: receipt.commit!,
					files,
					git_files: gitFiles,
					expected_source_version: current.current_version_id,
					working_branch_fence: { operation: id, check },
				},
				actor,
			);
			const { source: synced } = await this.deps.notebooks.getNotebook(pid, nid);
			if (synced.type !== 'git' || !synced.current_version_id || synced.commit !== receipt.commit)
				throw new ConflictError('Hub source changed during save completion');
			return await this.putSave(
				{
					...receipt,
					state: 'hub_synced',
					version_id: synced.current_version_id,
					error: undefined,
				},
				check,
			);
		} catch (error) {
			if (
				error instanceof ValidationError ||
				error instanceof BadRequestError ||
				error instanceof ForbiddenError
			)
				return finish({
					...receipt,
					state: 'conflict',
					error: `Committed remotely, but the hub could not import the commit: ${error.message}. Use Sync now to pull it once the problem is fixed.`,
				});
			logOperationalError(
				'working_branch.sync_pending',
				{ project_id: pid, notebook_id: nid, save_id: id },
				error,
			);
			return this.putSave(
				{
					...receipt,
					error: 'Committed remotely; hub synchronization is pending. Retry this operation.',
				},
				check,
			);
		}
	}

	private async acknowledgeSave(
		receipt: WorkingBranchSave,
		context: SaveContext,
	): Promise<WorkingBranchSave> {
		const { input, finish } = context;
		const { projectId: pid, notebookId: nid } = input;
		try {
			await this.deps.sessions.acknowledgeWorkingBranchSave(
				pid,
				receipt.session_id,
				nid,
				receipt.base_version_id,
				receipt.version_id!,
			);
		} catch (error) {
			if (!(error instanceof NotFoundError)) throw error;
		}
		return finish({ ...receipt, state: 'complete', error: undefined });
	}

	private async editSession(pid: ProjectId, nid: NotebookId, sid: SessionId) {
		const session = await this.deps.sessions.getSession(pid, sid);
		if (
			session.notebook_id !== nid ||
			session.status !== 'running' ||
			!sessionPersistsEdits(session) ||
			!session.sandbox_id ||
			session.ended_reason
		) {
			throw new ConflictError('Save requires a running persistent editor session');
		}
		if (!(await this.deps.sessions.ownsEditorClaim(session)))
			throw new ConflictError('Session no longer owns the editor');
		return session;
	}
	/**
	 * Stages from `remote_committed` on only import an already-public commit, so any principal with
	 * `working-branch.write` may finish them. Earlier stages read the author's sandbox or write the
	 * branch on the author's behalf.
	 */
	canResume(receipt: WorkingBranchSave, actor: UserId): boolean {
		return (
			receipt.author === actor ||
			SAVE_STAGES[receipt.state].rank >= SAVE_STAGES.remote_committed.rank
		);
	}
	async resume(
		pid: ProjectId,
		nid: NotebookId,
		id: string,
		actor: UserId,
		options: Pick<SaveWorkingBranchInput, 'workdir' | 'getSandbox' | 'authorize'>,
	): Promise<WorkingBranchSave> {
		return this.runSave({ ...options, projectId: pid, notebookId: nid, actor, id });
	}

	private async payload(receipt: WorkingBranchSave, root: string): Promise<SourceControlChange[]> {
		const key = workingBranchPaths(receipt.project_id, receipt.notebook_id).capture(receipt.id);
		const object = await this.deps.bucket.get(key);
		if (!object) throw new ConflictError('Recovery payload expired or is unavailable');
		const contents = WorkingBranchCaptureSchema.parse(await object.json());
		if (contents.length !== receipt.changes.length)
			throw new UnavailableError('Save payload does not match its manifest');
		return Promise.all(
			receipt.changes.map(async (change, index) => {
				if (contents[index].path !== change.path)
					throw new UnavailableError('Save payload path mismatch');
				const path = proposalRepositoryPath(root, change.path);
				if (change.operation === 'delete') return { path, operation: 'delete' as const };
				const bytes = decodeProposalContent(contents[index].content ?? '', 'base64');
				if (
					bytes.byteLength !== change.size_bytes ||
					(await proposalSha256(bytes)) !== change.sha256
				)
					throw new UnavailableError('Save payload failed integrity verification');
				return { path, operation: change.operation, content: bytes };
			}),
		);
	}
	async recovery(pid: ProjectId, nid: NotebookId, id: string): Promise<Uint8Array> {
		await this.source(pid, nid);
		const receipt = await this.getSave(pid, nid, id);
		const changes = await this.payload(receipt, '');
		const files: Record<string, Uint8Array> = {
			'manifest.json': new TextEncoder().encode(JSON.stringify(receipt, null, 2)),
		};
		for (const change of changes)
			if (change.operation !== 'delete') files[`files/${change.path}`] = change.content;
		return zipSync(files);
	}
	async openChangeRequest(
		pid: ProjectId,
		nid: NotebookId,
		actor: UserId,
		input: { title?: string; body?: string; draft?: boolean },
		authorize?: (notebook?: NotebookMeta) => Promise<void>,
	) {
		await this.source(pid, nid);
		return this.store.withLease(pid, nid, async (check, update) => {
			const { source, record } = await this.source(pid, nid);
			if (record.active_save)
				throw new ConflictError('Complete the pending save before opening a PR');
			const { writer } = this.provider(record.provider, source.repo, pid);
			const remote = await writer.inspectBranch({
				repository: source.repo,
				branch: source.branch,
				changeRequestNumber: record.change_request?.number,
			});
			const ended = record.ended_reason ?? branchEndedReason(remote, record.base_branch);
			await update((current) => ({
				...current,
				ended_reason: current.ended_reason ?? ended,
				change_request: storedChangeRequest(remote) ?? current.change_request,
				remote_commit: remote.headCommit,
				checked_at: new Date().toISOString(),
			}));
			if (ended)
				throw new ConflictError('Working branch publication ended; create a new working notebook');
			if (remote.headCommit !== source.commit)
				throw new ConflictError('Working branch moved; synchronize before opening its PR');
			const existing = storedChangeRequest(remote);
			if (existing) return existing;
			if (record.change_request) throw new ConflictError('The recorded PR could not be verified');
			const { meta } = await this.deps.notebooks.getNotebook(pid, nid);
			await check();
			await authorize?.();
			const result = await writer.openBranchChangeRequest({
				repository: source.repo,
				headBranch: source.branch,
				baseBranch: record.base_branch,
				title: input.title ?? meta.title,
				body: input.body ?? `Changes from marimohub notebook ${nid}.`,
				draft: input.draft ?? true,
			});
			await check();
			const inspected = await writer.inspectBranch({
				repository: source.repo,
				branch: source.branch,
				changeRequestNumber: result.number,
			});
			const opened = storedChangeRequest(inspected);
			if (!opened) throw new UnavailableError('Could not verify the opened PR');
			await update((current) => ({
				...current,
				change_request: opened,
				remote_commit: inspected.headCommit,
				ended_reason: current.ended_reason ?? branchEndedReason(inspected, current.base_branch),
				checked_at: new Date().toISOString(),
			}));
			return opened;
		});
	}
	private async expireRetiredSave(receipt: WorkingBranchSave): Promise<WorkingBranchSave> {
		const head = await this.store.read(receipt.project_id, receipt.notebook_id);
		if (head.state !== 'deleted') return receipt;
		const key = workingBranchPaths(receipt.project_id, receipt.notebook_id).save(receipt.id);
		return withCasRetry(this.deps.bucket, async (cas) => {
			const object = await this.deps.bucket.get(key);
			if (!object) return receipt;
			const fresh = await readStored(WorkingBranchSaveSchema, object, key);
			if (!SAVE_STAGES[fresh.state].expirable) return fresh;
			const expired: WorkingBranchSave = {
				...fresh,
				state: 'expired',
				error: 'Notebook deleted before publication',
			};
			await cas.put(key, JSON.stringify(expired), { onlyIfEtagMatches: object.etag });
			return expired;
		});
	}

	async pruneExpiredPayloads(now = Date.now()): Promise<number> {
		const cursorObject = await this.deps.bucket.get(WORKING_BRANCH_CLEANUP_KEY);
		const cursor = cursorObject
			? (await readStored(WorkingBranchCleanupSchema, cursorObject, WORKING_BRANCH_CLEANUP_KEY))
					.cursor
			: undefined;
		const page = await this.deps.bucket.list({
			prefix: '_system/working-branches/notebooks/',
			cursor,
			limit: 100,
		});
		let count = 0;
		for (const item of page.objects) {
			if (!item.key.endsWith('/receipt.json')) continue;
			try {
				const object = await this.deps.bucket.get(item.key);
				if (!object) continue;
				let receipt = await readStored(WorkingBranchSaveSchema, object, item.key);
				if (Date.parse(receipt.expires_at) + 3600_000 > now) continue;
				if (SAVE_STAGES[receipt.state].expirable) {
					try {
						receipt = await this.store.withLease(
							receipt.project_id,
							receipt.notebook_id,
							async (check, update) => {
								const fresh = await this.getSave(
									receipt.project_id,
									receipt.notebook_id,
									receipt.id,
								);
								if (!SAVE_STAGES[fresh.state].expirable) return fresh;
								const expired = await this.putSave(
									{ ...fresh, state: 'expired', error: 'Capture expired before publication' },
									check,
								);
								await update((record) =>
									record.active_save === receipt.id
										? { ...record, active_save: undefined }
										: record,
								);
								return expired;
							},
						);
					} catch (error) {
						if (!(error instanceof ConflictError)) throw error;
						receipt = await this.expireRetiredSave(receipt);
					}
				}
				// An unknown ref outcome can still become a remote commit; keep its capture and baseline.
				if (!SAVE_STAGES[receipt.state].terminal) continue;
				const captureKey = workingBranchPaths(receipt.project_id, receipt.notebook_id).capture(
					receipt.id,
				);
				if (await this.deps.bucket.head(captureKey)) {
					await this.deps.bucket.delete(captureKey);
					count++;
				}
			} catch (error) {
				logOperationalError('working_branch.cleanup_failed', { object: item.key }, error);
			}
		}
		if (page.cursor === cursor) return count;
		await putIfMatch(
			this.deps.bucket,
			WORKING_BRANCH_CLEANUP_KEY,
			JSON.stringify({ cursor: page.cursor }),
			cursorObject?.etag,
		);
		return count;
	}
}

function storedChangeRequest({
	changeRequest,
}: WorkingBranchInspection): WorkingBranchChangeRequest | undefined {
	if (!changeRequest) return undefined;
	const { number, url, state, headBranch, baseBranch } = changeRequest;
	return { number, url, state, head_branch: headBranch, base_branch: baseBranch };
}

function branchEndedReason(
	remote: {
		headCommit: string | null;
		changeRequest?: { state: 'open' | 'closed' | 'merged'; baseBranch: string };
	},
	baseBranch: string,
): WorkingBranchRecord['ended_reason'] {
	if (remote.headCommit === null) return 'branch_deleted';
	if (remote.changeRequest?.state === 'closed') return 'pr_closed';
	if (remote.changeRequest?.state === 'merged') return 'pr_merged';
	if (remote.changeRequest && remote.changeRequest.baseBranch !== baseBranch)
		return 'pr_retargeted';
	return undefined;
}
