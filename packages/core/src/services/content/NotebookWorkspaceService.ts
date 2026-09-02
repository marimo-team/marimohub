import { z } from 'zod';
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
	isProtectedWorkspacePath,
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
import { parseStored, readStoredJson, WorkspaceMutationClaimSchema } from '../../schema';
import type { Source, WorkspaceMutationClaim } from '../../schema';
import { acquireSingletonClaim, releaseSingletonClaim, withCasRetry } from '../catalog/cas';
import type { SingletonClaimConfig } from '../catalog/cas';
import { listAllObjects } from '../catalog/storage';
import type { NotebookDetail } from './NotebookService';

const DEFAULT_PAGE_SIZE = 200;
const WORKSPACE_MUTATION_LEASE_MS = 2 * 60_000;
const WORKSPACE_MUTATION_WAIT_ATTEMPTS = 100;
const WORKSPACE_MUTATION_RETRY_MS = 20;
/** Objects processed between lease renewals inside a multi-object mutation. */
export const WORKSPACE_MUTATION_HEARTBEAT_EVERY = 50;
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

export interface WorkspaceMutationOptions {
	/**
	 * Re-run once the mutation lease is held. The API passes its active-session
	 * check here: a session that starts between the route's pre-flight check and
	 * the lease would otherwise restore over (and later mirror-delete) the write.
	 */
	assertMutable?: () => Promise<void>;
}

interface MutationLease {
	/** Extend the lease; throws `ConflictError` when another mutator took it over. */
	heartbeat(): Promise<void>;
}

interface WorkspaceContext {
	detail: NotebookDetail;
	prefix: string | null;
}

interface ParsedWorkspaceMutationClaim {
	holder: string | null;
	expiresAt: number | null;
}

const LegacyWorkspaceMutationClaimSchema = z.object({ holder: z.string().nullable() });

const DENIED_VERBS: Record<WorkspaceOperation, string> = {
	create: 'created as a directory',
	write: 'written',
	move: 'moved',
	copy: 'replaced by a copy',
	delete: 'deleted',
};

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

function parseWorkspaceMutationClaim(raw: unknown, key: string): ParsedWorkspaceMutationClaim {
	const claim = WorkspaceMutationClaimSchema.safeParse(raw);
	if (claim.success) {
		const { holder, expires_at } = claim.data;
		return { holder, expiresAt: expires_at === null ? null : Date.parse(expires_at) };
	}
	// Pre-release bodies encoded the expiry in the holder as `<id>:<epoch-ms>`.
	// A body that fits neither shape is corrupt and surfaces to the CAS helper.
	const legacy = parseStored(LegacyWorkspaceMutationClaimSchema, raw, key);
	if (legacy.holder === null) return { holder: null, expiresAt: null };
	const separator = legacy.holder.lastIndexOf(':');
	const expiresAt = Number(legacy.holder.slice(separator + 1));
	return {
		holder: legacy.holder,
		expiresAt: separator > 0 && Number.isFinite(expiresAt) ? expiresAt : null,
	};
}

function claimIsLive(claim: ParsedWorkspaceMutationClaim): boolean {
	return claim.holder !== null && claim.expiresAt !== null && claim.expiresAt > Date.now();
}

function serializeWorkspaceMutationClaim(holder: string | null): string {
	const claim: WorkspaceMutationClaim =
		holder === null
			? { holder: null, expires_at: null }
			: { holder, expires_at: new Date(Date.now() + WORKSPACE_MUTATION_LEASE_MS).toISOString() };
	return JSON.stringify(claim);
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
		options: WorkspaceMutationOptions = {},
	): Promise<WorkspaceFileItem> {
		return this.withMutation(projectId, notebookId, options, () =>
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
		options: WorkspaceMutationOptions = {},
	): Promise<WorkspaceFileItem> {
		return this.withMutation(projectId, notebookId, options, () =>
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
		this.assertTargetUnprotected(context.detail.source, 'create', relative);
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

	async delete(
		projectId: ProjectId,
		notebookId: NotebookId,
		path: string,
		options: WorkspaceMutationOptions = {},
	): Promise<void> {
		return this.withMutation(projectId, notebookId, options, (lease) =>
			this.deleteUnlocked(projectId, notebookId, path, lease),
		);
	}

	private async deleteUnlocked(
		projectId: ProjectId,
		notebookId: NotebookId,
		path: string,
		lease: MutationLease,
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
		for (let index = 0; index < objects.length; index += WORKSPACE_MUTATION_HEARTBEAT_EVERY) {
			if (index > 0) await lease.heartbeat();
			const batch = objects.slice(index, index + WORKSPACE_MUTATION_HEARTBEAT_EVERY);
			await this.bucket.delete(batch.map((object) => object.key));
		}
	}

	async copy(
		projectId: ProjectId,
		notebookId: NotebookId,
		from: string,
		to: string,
		options: WorkspaceMutationOptions = {},
	): Promise<WorkspaceFileItem> {
		return this.withMutation(projectId, notebookId, options, (lease) =>
			this.copyUnlocked(projectId, notebookId, from, to, lease),
		);
	}

	private async copyUnlocked(
		projectId: ProjectId,
		notebookId: NotebookId,
		from: string,
		to: string,
		lease: MutationLease,
	): Promise<WorkspaceFileItem> {
		const context = await this.mutableContext(projectId, notebookId, 'copy', from);
		const source = normalizeWorkspacePathInput(from);
		const target = normalizeWorkspacePathInput(to);
		this.assertTargetUnprotected(context.detail.source, 'copy', target);
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
				if (written.length > 0 && written.length % WORKSPACE_MUTATION_HEARTBEAT_EVERY === 0) {
					await lease.heartbeat();
				}
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
		options: WorkspaceMutationOptions = {},
	): Promise<WorkspaceFileItem> {
		return this.withMutation(projectId, notebookId, options, (lease) =>
			this.moveUnlocked(projectId, notebookId, from, to, lease),
		);
	}

	private async moveUnlocked(
		projectId: ProjectId,
		notebookId: NotebookId,
		from: string,
		to: string,
		lease: MutationLease,
	): Promise<WorkspaceFileItem> {
		await this.mutableContext(projectId, notebookId, 'move', from);
		await this.mutableContext(projectId, notebookId, 'move', to);
		const copied = await this.copyUnlocked(projectId, notebookId, from, to, lease);
		try {
			await this.deleteUnlocked(projectId, notebookId, from, lease);
		} catch (error) {
			await this.deleteUnlocked(projectId, notebookId, to, lease).catch(() => {});
			throw error;
		}
		return copied;
	}

	private async withMutation<T>(
		projectId: ProjectId,
		notebookId: NotebookId,
		options: WorkspaceMutationOptions,
		mutation: (lease: MutationLease) => Promise<T>,
	): Promise<T> {
		const queueKey = `${projectId}/${notebookId}`;
		const previous = this.mutationQueues.get(queueKey) ?? Promise.resolve();
		const run = previous
			.catch(() => {})
			.then(() => this.withMutationClaim(projectId, notebookId, options, mutation));
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
		options: WorkspaceMutationOptions,
		mutation: (lease: MutationLease) => Promise<T>,
	): Promise<T> {
		const key = paths.project(projectId).notebook(notebookId).workspaceMutationClaim;
		const claim = this.claimConfig(key);
		const holder = VersionId.create();
		for (let attempt = 0; attempt < WORKSPACE_MUTATION_WAIT_ATTEMPTS; attempt++) {
			if ((await acquireSingletonClaim(claim, holder)).acquired) {
				try {
					await options.assertMutable?.();
					return await mutation({ heartbeat: () => this.renewClaim(key, holder) });
				} finally {
					await releaseSingletonClaim(claim, holder);
				}
			}
			await sleep(WORKSPACE_MUTATION_RETRY_MS);
		}
		throw new ConflictError('Workspace is busy with another mutation; retry the operation');
	}

	/** The mutation lease over `workspace_mutation_claim.json` (see WorkspaceMutationClaimSchema). */
	private claimConfig(key: string): SingletonClaimConfig {
		return {
			bucket: this.bucket,
			key,
			serialize: serializeWorkspaceMutationClaim,
			// An expired lease reads as released, so the CAS helper replaces it in
			// place instead of waiting on a holder that will never come back.
			parseHolder: (raw) => {
				const claim = parseWorkspaceMutationClaim(raw, key);
				return claimIsLive(claim) ? claim.holder : null;
			},
			isHolderLive: async () => true,
		};
	}

	/**
	 * Extend the lease while a long mutation runs. `acquireSingletonClaim` is a
	 * no-op for the current holder, so renewal needs its own CAS write.
	 */
	private async renewClaim(key: string, holder: string): Promise<void> {
		const renewed = await withCasRetry(this.bucket, async (cas) => {
			const existing = await this.bucket.get(key);
			if (!existing) return false;
			let current: ParsedWorkspaceMutationClaim;
			try {
				current = parseWorkspaceMutationClaim(await readStoredJson(existing, key), key);
			} catch {
				return false;
			}
			if (current.holder !== holder) return false;
			await cas.put(key, serializeWorkspaceMutationClaim(holder), {
				onlyIfEtagMatches: existing.etag,
			});
			return true;
		});
		if (!renewed) {
			throw new ConflictError('Workspace mutation lease was lost; retry the operation');
		}
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

	private assertTargetUnprotected(
		source: Source,
		operation: 'copy' | 'create',
		target: string,
	): void {
		if (isProtectedWorkspacePath(source, target)) {
			throw new ForbiddenError(this.deniedMessage(source, operation, target));
		}
	}

	private deniedMessage(source: Source, operation: WorkspaceOperation, path: string): string {
		if (!workspaceSourcePolicy(source).workspaceWritable) {
			return 'Git-backed workspaces are read-only';
		}
		return `${path} cannot be ${DENIED_VERBS[operation]}`;
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
