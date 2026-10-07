import { z } from 'zod';
import { BadRequestError, ConflictError, NotFoundError } from '../../errors';
import { createNotebookId } from '../../ids';
import type { ProjectId, UserId } from '../../ids';
import type { Bucket } from '../../ports/bucket';
import { paths } from '../../paths';
import { readStored, NotebookMetaSchema, NotebookIdSchema, UserIdSchema } from '../../schema';
import { parseWorkspaceArchive } from '../../integrations/workspaceArchive';
import {
	folderImportFileLimit,
	validateLocalEntryNotebook,
} from '../../integrations/remoteWorkspace';
import {
	isFolderImportExcludedPath,
	validateFolderImportPath,
} from '../../integrations/workspaceIgnore';
import { deleteByPrefix, listAllObjects } from '../catalog/storage';
import { withCasRetry } from '../catalog/cas';
import type { NotebookService } from './NotebookService';

export const IMPORT_RETENTION_MS = 24 * 60 * 60 * 1000;
const ATTEMPT_LEASE_MS = 10 * 60 * 1000;
const CLEANUP_GRACE_MS = 60 * 60 * 1000;
export const ImportNotebookInputSchema = z.object({
	entry_notebook: z.string().min(1),
	title: z.string().trim().min(1).max(200),
	base_image: z.string().optional(),
	compute_profile: z.string().optional(),
});
export type ImportNotebookInput = z.infer<typeof ImportNotebookInputSchema>;
export const NotebookImportPreparationSchema = z.object({
	actor: UserIdSchema,
	created_at: z.number(),
	expires_at: z.number(),
});
export const NotebookImportItemSchema = z.object({
	actor: UserIdSchema,
	input: ImportNotebookInputSchema,
	notebook_id: NotebookIdSchema,
	attempts: z.array(NotebookIdSchema),
	state: z.enum(['preparing', 'publishing', 'complete', 'expired']),
	notebook: NotebookMetaSchema.optional(),
	lease_until: z.number(),
});
export const notebookImportPrefix = (pid: ProjectId, id: string) =>
	`projects/${pid}/imports/${id}/`;
const validId = (id: string) => /^[0-9a-f-]{36}$/.test(id);

export class NotebookImportService {
	constructor(
		private bucket: Bucket,
		private notebooks: NotebookService,
	) {}

	async prepare(projectId: ProjectId, bytes: Uint8Array, actor: UserId) {
		const files = this.parse(bytes);
		const id = crypto.randomUUID();
		const prefix = notebookImportPrefix(projectId, id);
		const created_at = Date.now();
		const preparation = { actor, created_at, expires_at: created_at + IMPORT_RETENTION_MS };
		await this.bucket.put(`${prefix}snapshot.zip`, bytes, { onlyIfNotExists: true });
		await this.bucket.put(`${prefix}preparation.json`, JSON.stringify(preparation), {
			onlyIfNotExists: true,
		});
		return {
			id,
			expires_at: new Date(preparation.expires_at).toISOString(),
			files: files.map((file) => ({ path: file.path, size: file.bytes.byteLength })),
		};
	}

	async publish(
		projectId: ProjectId,
		id: string,
		rawInput: ImportNotebookInput,
		actor: UserId,
		resolveSettings?: () => Pick<ImportNotebookInput, 'base_image' | 'compute_profile'>,
	) {
		const prefix = this.prefix(projectId, id);
		const preparation = await this.preparation(prefix, actor);
		const input = ImportNotebookInputSchema.parse(rawInput);
		const key = this.itemKey(prefix, input.entry_notebook);
		const candidate = createNotebookId();
		const claimed = await withCasRetry(this.bucket, async (cas) => {
			const object = await this.bucket.get(key);
			const current = object ? await readStored(NotebookImportItemSchema, object, key) : null;
			if (
				current &&
				(current.actor !== actor || JSON.stringify(current.input) !== JSON.stringify(input))
			)
				throw new ConflictError('Import identity already has different notebook settings');
			if (current?.state === 'publishing' || current?.state === 'complete') return current;
			if (current?.state === 'expired' || preparation.expires_at <= Date.now())
				throw new ConflictError('Import expired; choose the folder again');
			if (current && current.lease_until > Date.now())
				throw new ConflictError('Notebook import is still in progress; check again shortly');
			if (current && current.attempts.length >= 10)
				throw new ConflictError('Import retry limit reached');
			const next: z.infer<typeof NotebookImportItemSchema> = {
				actor,
				input,
				notebook_id: candidate,
				attempts: [...(current?.attempts ?? []), candidate],
				state: 'preparing',
				lease_until: Date.now() + ATTEMPT_LEASE_MS,
			};
			await cas.put(
				key,
				JSON.stringify(next),
				object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
			);
			return next;
		});
		if (claimed.state === 'complete' && claimed.notebook) return claimed.notebook;
		if (claimed.state === 'preparing') {
			try {
				const settings = resolveSettings?.() ?? input;
				const archive = await this.bucket.get(`${prefix}snapshot.zip`);
				if (!archive) throw new NotFoundError('Import snapshot not found');
				const files = this.parse(await archive.bytes());
				const entry = files.find((file) => file.path === input.entry_notebook);
				if (!entry) throw new BadRequestError('Selected notebook is not included in the workspace');
				const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
				let code: string;
				let deps: string;
				try {
					code = decoder.decode(entry.bytes);
					deps = decoder.decode(
						files.find((file) => file.path === 'pyproject.toml')?.bytes ?? new Uint8Array(),
					);
				} catch {
					throw new BadRequestError('Notebook and pyproject.toml must be UTF-8 text');
				}
				await this.notebooks.stageImportNotebook(
					projectId,
					candidate,
					{
						...input,
						...settings,
						description: '',
						code,
						deps,
						workspaceFiles: files,
					},
					actor,
				);
				await withCasRetry(this.bucket, async (cas) => {
					const object = await this.bucket.get(key);
					if (!object) throw new ConflictError('Import attempt expired');
					const current = await readStored(NotebookImportItemSchema, object, key);
					if (current.state !== 'preparing' || current.notebook_id !== candidate)
						throw new ConflictError('Import attempt was replaced');
					await cas.put(key, JSON.stringify({ ...current, state: 'publishing' }), {
						onlyIfEtagMatches: object.etag,
					});
				});
			} catch (error) {
				// A lost CAS response may already have authorized publication. Never delete that workspace.
				await withCasRetry(this.bucket, async (cas) => {
					const object = await this.bucket.get(key);
					if (!object) return;
					const current = await readStored(NotebookImportItemSchema, object, key);
					if (current.state === 'preparing' && current.notebook_id === candidate) {
						await cas.put(key, JSON.stringify({ ...current, lease_until: 0 }), {
							onlyIfEtagMatches: object.etag,
						});
					}
				}).catch(() => {});
				throw error;
			}
		}
		const meta = await this.notebooks.publishImportNotebook(projectId, claimed.notebook_id, actor);
		await withCasRetry(this.bucket, async (cas) => {
			const object = await this.bucket.get(key);
			if (!object) return;
			const current = await readStored(NotebookImportItemSchema, object, key);
			if (current.state === 'publishing')
				await cas.put(key, JSON.stringify({ ...current, state: 'complete', notebook: meta }), {
					onlyIfEtagMatches: object.etag,
				});
		});
		return meta;
	}

	async status(projectId: ProjectId, id: string, entry: string, actor: UserId) {
		const prefix = this.prefix(projectId, id);
		const preparation = await this.preparation(prefix, actor);
		const key = this.itemKey(prefix, entry);
		const object = await this.bucket.get(key);
		if (!object)
			return {
				state: preparation.expires_at <= Date.now() ? ('expired' as const) : ('pending' as const),
			};
		const item = await readStored(NotebookImportItemSchema, object, key);
		if (item.state === 'complete' && item.notebook)
			return { state: 'complete' as const, notebook: item.notebook };
		if (item.state === 'publishing') return { state: 'publishing' as const };
		return {
			state:
				item.state === 'expired' || preparation.expires_at <= Date.now()
					? ('expired' as const)
					: item.lease_until > Date.now()
						? ('preparing' as const)
						: ('pending' as const),
		};
	}

	async sweep(projectId: ProjectId): Promise<void> {
		const prefix = `projects/${projectId}/imports/`;
		for (const object of await listAllObjects(this.bucket, prefix)) {
			if (object.uploaded.getTime() + IMPORT_RETENTION_MS + CLEANUP_GRACE_MS > Date.now()) continue;
			if (object.key.endsWith('/snapshot.zip')) {
				const base = object.key.slice(0, -'snapshot.zip'.length);
				if (!(await this.bucket.head(`${base}preparation.json`)))
					await this.bucket.delete(object.key);
				continue;
			}
			if (!object.key.endsWith('/preparation.json')) continue;
			const base = object.key.slice(0, -'preparation.json'.length);
			const preparation = await this.bucket.get(`${base}preparation.json`);
			if (!preparation) {
				await this.bucket.delete(object.key);
				continue;
			}
			for (const itemObject of await listAllObjects(this.bucket, `${base}items/`)) {
				const item = await withCasRetry(this.bucket, async (cas) => {
					const currentObject = await this.bucket.get(itemObject.key);
					if (!currentObject) return null;
					const current = await readStored(NotebookImportItemSchema, currentObject, itemObject.key);
					if (current.state === 'preparing') {
						const next = { ...current, state: 'expired' as const };
						await cas.put(itemObject.key, JSON.stringify(next), {
							onlyIfEtagMatches: currentObject.etag,
						});
						return next;
					}
					return current;
				});
				if (!item) continue;
				if (item.state === 'publishing') {
					await this.publish(projectId, base.slice(prefix.length, -1), item.input, item.actor);
				}
				for (const notebookId of item.attempts) {
					if (
						notebookId === item.notebook_id &&
						(item.state === 'publishing' || item.state === 'complete')
					)
						continue;
					await deleteByPrefix(
						this.bucket,
						`${paths.project(projectId).notebook(notebookId).base}/`,
					);
				}
			}
			await this.bucket.delete(`${base}snapshot.zip`);
			// Receipts remain: replays must never resurrect a deleted or subsequently edited notebook.
		}
	}

	private itemKey(prefix: string, entry: string) {
		validateLocalEntryNotebook(entry);
		return `${prefix}items/${encodeURIComponent(entry)}.json`;
	}

	private prefix(projectId: ProjectId, id: string) {
		if (!validId(id)) throw new BadRequestError('Invalid import id');
		return notebookImportPrefix(projectId, id);
	}

	private async preparation(prefix: string, actor: UserId) {
		const key = `${prefix}preparation.json`;
		const object = await this.bucket.get(key);
		if (!object) throw new NotFoundError('Import not found');
		const preparation = await readStored(NotebookImportPreparationSchema, object, key);
		if (preparation.actor !== actor) throw new NotFoundError('Import not found');
		return preparation;
	}

	private parse(bytes: Uint8Array) {
		const files = parseWorkspaceArchive(bytes, 'zip', 'application/zip');
		const fileLimit = folderImportFileLimit(files);
		if (files.length > fileLimit)
			throw new BadRequestError(
				files.some((file) => file.path === 'pyproject.toml')
					? `Include at most ${fileLimit} files.`
					: `Include at most ${fileLimit} files; reserve one workspace file for generated pyproject.toml.`,
			);
		const paths = new Set(files.map((file) => validateFolderImportPath(file.path)));
		for (const file of files) {
			if (isFolderImportExcludedPath(file.path))
				throw new BadRequestError(
					`Exclude generated or Git metadata before importing: ${file.path}`,
				);
			const segments = file.path.split('/');
			for (let index = 1; index < segments.length; index++)
				if (paths.has(segments.slice(0, index).join('/')))
					throw new BadRequestError(`File conflicts with directory: ${file.path}`);
		}
		if (files.length === 0) throw new BadRequestError('Folder contains no included files');
		return files;
	}
}
