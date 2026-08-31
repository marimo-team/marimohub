import {
	MAX_WORKSPACE_BYTES,
	MAX_WORKSPACE_FILE_BYTES,
	MAX_WORKSPACE_FILES,
} from '../../constants';
import { sleep } from '../../duration';
import {
	BadRequestError,
	ConflictError,
	ForbiddenError,
	NotFoundError,
	PreconditionFailedError,
	ResourceExhaustedError,
} from '../../errors';
import { VersionId } from '../../ids';
import type { NotebookId, ProjectId, UserId } from '../../ids';
import {
	isWorkspaceDirectoryMarkerPath,
	workspaceDirectoryFromMarkerPath,
	workspaceDirectoryMarkerPath,
	workspaceOperationDenied,
	workspaceSourcePolicy,
} from '../../integrations/remoteWorkspace';
import type { WorkspaceOperation } from '../../integrations/remoteWorkspace';
import {
	normalizeWorkspaceDirectoryInput,
	normalizeWorkspacePathInput,
	workspaceMimeType,
	workspacePathName,
} from '../../integrations/workspaceFiles';
import { paths } from '../../paths';
import type { Bucket, BucketObject } from '../../ports/bucket';
import type { Source } from '../../schema';
import { acquireSingletonClaim, releaseSingletonClaim } from '../catalog/cas';
import { listAllObjects } from '../catalog/storage';
import type { NotebookDetail } from './NotebookService';

const DEFAULT_PAGE_SIZE = 200;
const WORKSPACE_MUTATION_LEASE_MS = 2 * 60_000;
const WORKSPACE_MUTATION_WAIT_ATTEMPTS = 100;
const WORKSPACE_MUTATION_RETRY_MS = 20;
export const MAX_WORKSPACE_SEARCH_RESULTS = 200;

export interface WorkspaceFileItem {
	path: string;
	name: string;
	kind: 'file' | 'directory';
	size?: number;
	modifiedAt?: number;
	mimeType?: string;
}

export interface WorkspaceListResult {
	items: WorkspaceFileItem[];
	cursor?: string;
}

interface WorkspaceServiceOwner {
	getNotebook(projectId: ProjectId, notebookId: NotebookId): Promise<NotebookDetail>;
	saveSourceFile(
		projectId: ProjectId,
		notebookId: NotebookId,
		path: 'notebook.py' | 'pyproject.toml',
		content: string,
		actor: UserId,
	): Promise<void>;
}

interface WorkspaceContext {
	detail: NotebookDetail;
	prefix: string | null;
}

function fileItem(path: string, object: BucketObject): WorkspaceFileItem {
	return {
		path,
		name: workspacePathName(path),
		kind: 'file',
		size: object.size,
		modifiedAt: object.uploaded.getTime(),
		mimeType: workspaceMimeType(path),
	};
}

function directoryItem(path: string): WorkspaceFileItem {
	return { path, name: workspacePathName(path), kind: 'directory' };
}

function assertTextSource(path: string, bytes: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		throw new BadRequestError(`${path} must contain valid UTF-8 text`);
	}
}

function parseWorkspaceMutationHolder(raw: unknown): string | null {
	if (typeof raw !== 'object' || raw === null || !('holder' in raw)) {
		throw new Error('Invalid workspace mutation claim');
	}
	const holder = raw.holder;
	if (holder !== null && typeof holder !== 'string') {
		throw new Error('Invalid workspace mutation claim holder');
	}
	return holder;
}

function workspaceMutationHolderIsLive(holder: string): boolean {
	const separator = holder.lastIndexOf(':');
	const expiresAt = Number(holder.slice(separator + 1));
	return separator > 0 && Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export class NotebookWorkspaceService {
	private readonly mutationQueues = new Map<string, Promise<void>>();

	constructor(
		private readonly bucket: Bucket,
		private readonly owner: WorkspaceServiceOwner,
	) {}

	async access(projectId: ProjectId, notebookId: NotebookId) {
		const { source } = await this.owner.getNotebook(projectId, notebookId);
		const policy = workspaceSourcePolicy(source);
		return {
			writable: policy.workspaceWritable,
			protectedPaths: policy.protectedPaths,
		};
	}

	async list(
		projectId: ProjectId,
		notebookId: NotebookId,
		path = '',
		cursor?: string,
		limit = DEFAULT_PAGE_SIZE,
	): Promise<WorkspaceListResult> {
		const context = await this.context(projectId, notebookId);
		if (!context.prefix) return { items: [] };
		const directory = normalizeWorkspaceDirectoryInput(path);
		const prefix = `${context.prefix}${directory ? `${directory}/` : ''}`;
		const result = await this.bucket.list({ prefix, delimiter: '/', cursor, limit });
		const entries = new Map<string, WorkspaceFileItem>();
		for (const object of result.objects) {
			const relative = object.key.slice(context.prefix.length);
			if (!relative || isWorkspaceDirectoryMarkerPath(relative)) continue;
			entries.set(relative, fileItem(relative, object));
		}
		for (const childPrefix of result.delimitedPrefixes) {
			const relative = childPrefix.slice(context.prefix.length).replace(/\/$/, '');
			if (relative) entries.set(relative, directoryItem(relative));
		}
		return {
			items: [...entries.values()],
			...(result.truncated && result.cursor ? { cursor: result.cursor } : {}),
		};
	}

	async stat(
		projectId: ProjectId,
		notebookId: NotebookId,
		path: string,
	): Promise<WorkspaceFileItem> {
		const context = await this.context(projectId, notebookId);
		if (!context.prefix) throw new NotFoundError('Workspace entry not found');
		const relative = normalizeWorkspacePathInput(path);
		return this.statIn(context.prefix, relative);
	}

	async read(
		projectId: ProjectId,
		notebookId: NotebookId,
		path: string,
	): Promise<{ item: WorkspaceFileItem; bytes: Uint8Array }> {
		const context = await this.context(projectId, notebookId);
		if (!context.prefix) throw new NotFoundError('Workspace file not found');
		const relative = normalizeWorkspacePathInput(path);
		const key = `${context.prefix}${relative}`;
		const head = await this.bucket.head(key);
		if (!head || key.endsWith('/')) throw new NotFoundError(`Workspace file ${relative} not found`);
		if (head.size > MAX_WORKSPACE_FILE_BYTES) {
			throw new ResourceExhaustedError(`Workspace file exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes`);
		}
		const body = await this.bucket.get(key);
		if (!body) throw new NotFoundError(`Workspace file ${relative} not found`);
		return { item: fileItem(relative, head), bytes: await body.bytes() };
	}

	async search(
		projectId: ProjectId,
		notebookId: NotebookId,
		query: string,
		path = '',
	): Promise<WorkspaceFileItem[]> {
		const context = await this.context(projectId, notebookId);
		if (!context.prefix) return [];
		const directory = normalizeWorkspaceDirectoryInput(path);
		const prefix = `${context.prefix}${directory ? `${directory}/` : ''}`;
		const needle = query.trim().toLowerCase();
		if (!needle) return [];
		const objects = await listAllObjects(this.bucket, prefix);
		const results = new Map<string, WorkspaceFileItem>();
		for (const object of objects) {
			const relative = object.key.slice(context.prefix.length);
			if (!relative) continue;
			const markerDirectory = workspaceDirectoryFromMarkerPath(relative);
			if (markerDirectory !== null) {
				const directoryPath = markerDirectory;
				if (directoryPath.toLowerCase().includes(needle)) {
					results.set(directoryPath, directoryItem(directoryPath));
				}
				if (results.size >= MAX_WORKSPACE_SEARCH_RESULTS) break;
				continue;
			}
			const segments = relative.split('/');
			for (let index = 1; index < segments.length; index++) {
				const directoryPath = segments.slice(0, index).join('/');
				if (directoryPath.toLowerCase().includes(needle)) {
					results.set(directoryPath, directoryItem(directoryPath));
				}
			}
			if (relative.toLowerCase().includes(needle)) {
				results.set(relative, fileItem(relative, object));
			}
			if (results.size >= MAX_WORKSPACE_SEARCH_RESULTS) break;
		}
		return [...results.values()].slice(0, MAX_WORKSPACE_SEARCH_RESULTS);
	}

	async write(
		projectId: ProjectId,
		notebookId: NotebookId,
		path: string,
		bytes: Uint8Array,
		actor: UserId,
		createOnly = false,
	): Promise<WorkspaceFileItem> {
		return this.withMutation(projectId, notebookId, () =>
			this.writeUnlocked(projectId, notebookId, path, bytes, actor, createOnly),
		);
	}

	private async writeUnlocked(
		projectId: ProjectId,
		notebookId: NotebookId,
		path: string,
		bytes: Uint8Array,
		actor: UserId,
		createOnly: boolean,
	): Promise<WorkspaceFileItem> {
		const context = await this.mutableContext(projectId, notebookId, 'write', path);
		const relative = normalizeWorkspacePathInput(path);
		if (bytes.byteLength > MAX_WORKSPACE_FILE_BYTES) {
			throw new ResourceExhaustedError(`Workspace file exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes`);
		}
		const key = `${context.prefix}${relative}`;
		const existing = await this.bucket.head(key);
		if ((!existing && (await this.exists(context.prefix, relative))) || (createOnly && existing)) {
			throw new ConflictError(`Workspace entry ${relative} already exists`);
		}
		await this.assertParentDirectories(context.prefix, relative);
		await this.assertCapacity(
			context.prefix,
			existing ? 0 : 1,
			bytes.byteLength - (existing?.size ?? 0),
		);

		if (relative === 'notebook.py' || relative === 'pyproject.toml') {
			await this.owner.saveSourceFile(
				projectId,
				notebookId,
				relative,
				assertTextSource(relative, bytes),
				actor,
			);
		} else {
			try {
				await this.bucket.put(key, bytes, {
					httpMetadata: { contentType: workspaceMimeType(relative) },
					...(createOnly ? { onlyIfNotExists: true } : {}),
				});
			} catch (error) {
				if (error instanceof PreconditionFailedError) {
					throw new ConflictError(`Workspace entry ${relative} already exists`);
				}
				throw error;
			}
		}
		return this.statIn(context.prefix, relative);
	}

	async createDirectory(
		projectId: ProjectId,
		notebookId: NotebookId,
		path: string,
	): Promise<WorkspaceFileItem> {
		return this.withMutation(projectId, notebookId, () =>
			this.createDirectoryUnlocked(projectId, notebookId, path),
		);
	}

	private async createDirectoryUnlocked(
		projectId: ProjectId,
		notebookId: NotebookId,
		path: string,
	): Promise<WorkspaceFileItem> {
		const context = await this.mutableContext(projectId, notebookId, 'create', path);
		const relative = normalizeWorkspacePathInput(path);
		if (await this.exists(context.prefix, relative)) {
			throw new ConflictError(`Workspace entry ${relative} already exists`);
		}
		await this.assertParentDirectories(context.prefix, relative);
		try {
			await this.bucket.put(
				`${context.prefix}${workspaceDirectoryMarkerPath(relative)}`,
				new Uint8Array(),
				{
					onlyIfNotExists: true,
				},
			);
		} catch (error) {
			if (error instanceof PreconditionFailedError) {
				throw new ConflictError(`Workspace entry ${relative} already exists`);
			}
			throw error;
		}
		return directoryItem(relative);
	}

	async delete(projectId: ProjectId, notebookId: NotebookId, path: string): Promise<void> {
		return this.withMutation(projectId, notebookId, () =>
			this.deleteUnlocked(projectId, notebookId, path),
		);
	}

	private async deleteUnlocked(
		projectId: ProjectId,
		notebookId: NotebookId,
		path: string,
	): Promise<void> {
		const context = await this.mutableContext(projectId, notebookId, 'delete', path);
		const relative = normalizeWorkspacePathInput(path);
		const key = `${context.prefix}${relative}`;
		const direct = await this.bucket.head(key);
		if (direct) {
			await this.bucket.delete(key);
			return;
		}
		const objects = await listAllObjects(this.bucket, `${key}/`);
		if (objects.length === 0) throw new NotFoundError(`Workspace entry ${relative} not found`);
		await this.bucket.delete(objects.map((object) => object.key));
	}

	async copy(
		projectId: ProjectId,
		notebookId: NotebookId,
		from: string,
		to: string,
	): Promise<WorkspaceFileItem> {
		return this.withMutation(projectId, notebookId, () =>
			this.copyUnlocked(projectId, notebookId, from, to),
		);
	}

	private async copyUnlocked(
		projectId: ProjectId,
		notebookId: NotebookId,
		from: string,
		to: string,
	): Promise<WorkspaceFileItem> {
		const context = await this.mutableContext(projectId, notebookId, 'copy', from);
		const source = normalizeWorkspacePathInput(from);
		const target = normalizeWorkspacePathInput(to);
		if (source === target || target.startsWith(`${source}/`)) {
			throw new BadRequestError('Cannot copy a workspace entry into itself');
		}
		if (await this.exists(context.prefix, target)) {
			throw new ConflictError(`Workspace entry ${target} already exists`);
		}
		await this.assertParentDirectories(context.prefix, target);

		const sourceKey = `${context.prefix}${source}`;
		const direct = await this.bucket.head(sourceKey);
		const sourceObjects = direct ? [direct] : await listAllObjects(this.bucket, `${sourceKey}/`);
		if (sourceObjects.length === 0) throw new NotFoundError(`Workspace entry ${source} not found`);
		const additions = sourceObjects.filter((object) => {
			const relative = object.key.slice(context.prefix.length);
			return !isWorkspaceDirectoryMarkerPath(relative);
		});
		await this.assertCapacity(
			context.prefix,
			additions.length,
			additions.reduce((total, object) => total + object.size, 0),
		);

		const written: string[] = [];
		try {
			for (const object of sourceObjects) {
				const suffix = direct ? '' : object.key.slice(sourceKey.length);
				const targetKey = `${context.prefix}${target}${suffix}`;
				const body = await this.bucket.get(object.key);
				if (!body) throw new ConflictError(`Workspace entry ${source} changed during copy`);
				await this.bucket.put(targetKey, await body.bytes(), { onlyIfNotExists: true });
				written.push(targetKey);
			}
		} catch (error) {
			if (written.length > 0) await this.bucket.delete(written).catch(() => {});
			if (error instanceof PreconditionFailedError) {
				throw new ConflictError(`Workspace entry ${target} already exists`);
			}
			throw error;
		}
		return direct ? this.statIn(context.prefix, target) : directoryItem(target);
	}

	async move(
		projectId: ProjectId,
		notebookId: NotebookId,
		from: string,
		to: string,
	): Promise<WorkspaceFileItem> {
		return this.withMutation(projectId, notebookId, () =>
			this.moveUnlocked(projectId, notebookId, from, to),
		);
	}

	private async moveUnlocked(
		projectId: ProjectId,
		notebookId: NotebookId,
		from: string,
		to: string,
	): Promise<WorkspaceFileItem> {
		await this.mutableContext(projectId, notebookId, 'move', from);
		await this.mutableContext(projectId, notebookId, 'move', to);
		const copied = await this.copyUnlocked(projectId, notebookId, from, to);
		try {
			await this.deleteUnlocked(projectId, notebookId, from);
		} catch (error) {
			await this.deleteUnlocked(projectId, notebookId, to).catch(() => {});
			throw error;
		}
		return copied;
	}

	private async withMutation<T>(
		projectId: ProjectId,
		notebookId: NotebookId,
		mutation: () => Promise<T>,
	): Promise<T> {
		const queueKey = `${projectId}/${notebookId}`;
		const previous = this.mutationQueues.get(queueKey) ?? Promise.resolve();
		const run = previous
			.catch(() => {})
			.then(() => this.withMutationClaim(projectId, notebookId, mutation));
		const settled = run.then(
			() => {},
			() => {},
		);
		this.mutationQueues.set(queueKey, settled);
		try {
			return await run;
		} finally {
			if (this.mutationQueues.get(queueKey) === settled) this.mutationQueues.delete(queueKey);
		}
	}

	private async withMutationClaim<T>(
		projectId: ProjectId,
		notebookId: NotebookId,
		mutation: () => Promise<T>,
	): Promise<T> {
		const key = paths.project(projectId).notebook(notebookId).workspaceMutationClaim;
		const claim = {
			bucket: this.bucket,
			key,
			serialize: (holder: string | null) => JSON.stringify({ holder }),
			parseHolder: parseWorkspaceMutationHolder,
			isHolderLive: async (holder: string) => workspaceMutationHolderIsLive(holder),
		};
		const claimId = VersionId.create();
		let holder = '';
		for (let attempt = 0; attempt < WORKSPACE_MUTATION_WAIT_ATTEMPTS; attempt++) {
			holder = `${claimId}:${Date.now() + WORKSPACE_MUTATION_LEASE_MS}`;
			if ((await acquireSingletonClaim(claim, holder)).acquired) {
				try {
					return await mutation();
				} finally {
					await releaseSingletonClaim(claim, holder);
				}
			}
			await sleep(WORKSPACE_MUTATION_RETRY_MS);
		}
		throw new ConflictError('Workspace is busy with another mutation; retry the operation');
	}

	private async context(projectId: ProjectId, notebookId: NotebookId): Promise<WorkspaceContext> {
		const detail = await this.owner.getNotebook(projectId, notebookId);
		const nb = paths.project(projectId).notebook(notebookId);
		const prefix =
			detail.source.type === 'local'
				? nb.workspacePrefix
				: detail.source.current_version_id
					? nb.version(detail.source.current_version_id).workspacePrefix
					: null;
		return { detail, prefix };
	}

	private async mutableContext(
		projectId: ProjectId,
		notebookId: NotebookId,
		operation: WorkspaceOperation,
		path: string,
	): Promise<WorkspaceContext & { prefix: string }> {
		const context = await this.context(projectId, notebookId);
		const relative = normalizeWorkspacePathInput(path);
		if (!context.prefix || workspaceOperationDenied(context.detail.source, operation, relative)) {
			throw new ForbiddenError(this.deniedMessage(context.detail.source, operation, relative));
		}
		return { ...context, prefix: context.prefix };
	}

	private deniedMessage(source: Source, operation: WorkspaceOperation, path: string): string {
		if (!workspaceSourcePolicy(source).workspaceWritable) {
			return 'Git-backed workspaces are read-only';
		}
		return `${path} cannot be ${operation === 'delete' ? 'deleted' : 'moved'}`;
	}

	private async statIn(prefix: string, relative: string): Promise<WorkspaceFileItem> {
		const object = await this.bucket.head(`${prefix}${relative}`);
		if (object) return fileItem(relative, object);
		if (await this.exists(prefix, relative)) return directoryItem(relative);
		throw new NotFoundError(`Workspace entry ${relative} not found`);
	}

	private async exists(prefix: string, relative: string): Promise<boolean> {
		if (await this.bucket.head(`${prefix}${relative}`)) return true;
		const result = await this.bucket.list({ prefix: `${prefix}${relative}/`, limit: 1 });
		return result.objects.length > 0 || result.delimitedPrefixes.length > 0;
	}

	private async assertParentDirectories(prefix: string, relative: string): Promise<void> {
		const segments = relative.split('/');
		for (let index = 1; index < segments.length; index++) {
			const parent = segments.slice(0, index).join('/');
			if (await this.bucket.head(`${prefix}${parent}`)) {
				throw new ConflictError(`Workspace entry ${parent} is not a directory`);
			}
		}
	}

	private async assertCapacity(
		prefix: string,
		addedFiles: number,
		addedBytes: number,
	): Promise<void> {
		const objects = (await listAllObjects(this.bucket, prefix)).filter(
			(object) => !isWorkspaceDirectoryMarkerPath(object.key.slice(prefix.length)),
		);
		if (objects.length + addedFiles > MAX_WORKSPACE_FILES) {
			throw new ResourceExhaustedError(`Workspace exceeds ${MAX_WORKSPACE_FILES} files`);
		}
		const currentBytes = objects.reduce((total, object) => total + object.size, 0);
		if (currentBytes + addedBytes > MAX_WORKSPACE_BYTES) {
			throw new ResourceExhaustedError(`Workspace exceeds ${MAX_WORKSPACE_BYTES} bytes`);
		}
	}
}
