import { z } from 'zod';
import {
	BadRequestError,
	ConflictError,
	ImportRestartRequiredError,
	NotFoundError,
} from '../../errors';
import { logOperationalError } from '../../operationalLog';
import { createImportId, createNotebookId, ImportId } from '../../ids';
import type { ProjectId, UserId } from '../../ids';
import type { Bucket } from '../../ports/bucket';
import { paths } from '../../paths';
import type { NotebookImportPaths } from '../../paths';
import { mapWithConcurrency } from '../../concurrency';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { sha256Hex } from '../../internal/sha256';
import { readStored, NotebookMetaSchema, NotebookIdSchema, UserIdSchema } from '../../schema';
import type { NotebookMeta } from '../../schema';
import { parseWorkspaceArchive } from '../../integrations/workspaceArchive';
import {
	folderImportFileLimit,
	validateLocalEntryNotebook,
} from '../../integrations/remoteWorkspace';
import {
	folderImportExcludedDirectories,
	isFolderImportExcludedPath,
	validateFolderImportPath,
} from '../../integrations/workspaceIgnore';
import { deleteByPrefix, listAllObjects } from '../catalog/storage';
import { withCasRetry } from '../catalog/cas';
import type { NotebookService } from './NotebookService';

export const IMPORT_RETENTION_MS = 24 * 60 * 60 * 1000;
// Receipts outlive the snapshot so lost responses and stalled attempts still
// reconcile; past this horizon the whole import prefix is deleted.
export const IMPORT_PURGE_MS = 7 * 24 * 60 * 60 * 1000;
const ATTEMPT_LEASE_MS = 10 * 60 * 1000;
const CLEANUP_GRACE_MS = 60 * 60 * 1000;
const MAX_IMPORT_ATTEMPTS = 10;
export const ImportNotebookInputSchema = z.object({
	entry_notebook: z.string().min(1),
	title: z.string().trim().min(1),
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
type NotebookImportItem = z.infer<typeof NotebookImportItemSchema>;

type ImportSettings = Pick<ImportNotebookInput, 'base_image' | 'compute_profile'>;

export class NotebookImportService {
	constructor(
		private bucket: Bucket,
		private notebooks: NotebookService,
	) {}

	async prepare(projectId: ProjectId, bytes: Uint8Array, actor: UserId) {
		const files = this.parse(bytes);
		const id = createImportId();
		const imp = paths.project(projectId).notebookImport(id);
		const created_at = Date.now();
		const preparation = { actor, created_at, expires_at: created_at + IMPORT_RETENTION_MS };
		await this.bucket.put(imp.snapshot, bytes, { onlyIfNotExists: true });
		await this.bucket.put(imp.preparation, JSON.stringify(preparation), {
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
		resolveSettings?: () => ImportSettings,
	) {
		const imp = this.paths(projectId, id);
		const preparation = await this.preparation(imp, actor);
		const input = ImportNotebookInputSchema.parse(rawInput);
		const key = await this.itemKey(imp, input.entry_notebook);
		const candidate = createNotebookId();
		let settings: ImportSettings | undefined;
		const claimed = await withCasRetry(this.bucket, async (cas) => {
			const object = await this.bucket.get(key);
			const current = object ? await readStored(NotebookImportItemSchema, object, key) : null;
			if (
				current &&
				(current.actor !== actor || JSON.stringify(current.input) !== JSON.stringify(input))
			)
				throw new ImportRestartRequiredError(
					'Import identity already has different notebook settings',
				);
			if (current?.state === 'publishing' || current?.state === 'complete') return current;
			if (current?.state === 'expired')
				throw new ImportRestartRequiredError('Import expired; choose the folder again');
			if (current && current.lease_until > Date.now())
				throw new ConflictError('Notebook import is still in progress; check again shortly');
			const restartReason =
				preparation.expires_at <= Date.now()
					? 'Import expired; choose the folder again'
					: current && current.attempts.length >= MAX_IMPORT_ATTEMPTS
						? 'Import retry limit reached'
						: null;
			if (restartReason) {
				// Fence stalled writers before promising that this entry cannot publish.
				await cas.put(
					key,
					JSON.stringify({
						...(current ?? { actor, input, notebook_id: candidate, attempts: [], lease_until: 0 }),
						state: 'expired',
					}),
					object ? { onlyIfEtagMatches: object.etag } : { onlyIfNotExists: true },
				);
				throw new ImportRestartRequiredError(restartReason);
			}
			settings = resolveSettings?.() ?? input;
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
			let renewAt = claimed.lease_until - ATTEMPT_LEASE_MS / 2;
			let renewing: Promise<void> | undefined;
			const beforeWrite = () => {
				if (renewing) return renewing;
				if (Date.now() < renewAt) return Promise.resolve();
				// Concurrent workspace writes share one heartbeat and stop if their claim was replaced.
				renewing = withCasRetry(this.bucket, async (cas) => {
					const object = await this.bucket.get(key);
					if (!object) throw new ConflictError('Import attempt expired');
					const current = await readStored(NotebookImportItemSchema, object, key);
					if (current.state !== 'preparing' || current.notebook_id !== candidate)
						throw new ConflictError('Import attempt was replaced');
					const lease_until = Date.now() + ATTEMPT_LEASE_MS;
					await cas.put(key, JSON.stringify({ ...current, lease_until }), {
						onlyIfEtagMatches: object.etag,
					});
					renewAt = lease_until - ATTEMPT_LEASE_MS / 2;
				}).finally(() => {
					renewing = undefined;
				});
				return renewing;
			};
			try {
				const archive = await this.bucket.get(imp.snapshot);
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
					beforeWrite,
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
				}).catch((releaseError: unknown) =>
					logOperationalError(
						'notebook_import_lease_release_failed',
						{ projectId, importId: id, notebookId: candidate },
						releaseError,
					),
				);
				throw error;
			}
		}
		let meta: NotebookMeta;
		try {
			meta = await this.notebooks.publishImportNotebook(projectId, claimed.notebook_id, actor);
		} catch (error) {
			if (!(error instanceof NotFoundError)) throw error;
			await this.settle(key, claimed.notebook_id, (current) => ({
				...current,
				state: 'expired',
				// The user deleted this notebook; leave its files to notebook deletion.
				attempts: current.attempts.filter((notebookId) => notebookId !== current.notebook_id),
			}));
			throw new ImportRestartRequiredError(
				'Imported notebook was deleted; choose the folder again',
			);
		}
		await this.settle(key, claimed.notebook_id, (current) => ({
			...current,
			state: 'complete',
			notebook: meta,
		}));
		return meta;
	}

	async get(projectId: ProjectId, id: string, actor: UserId) {
		const imp = this.paths(projectId, id);
		const preparation = await this.preparation(imp, actor);
		const objects = await listAllObjects(this.bucket, imp.itemsPrefix);
		const items = await mapWithConcurrency(objects, BUCKET_SCAN_CONCURRENCY, async ({ key }) => {
			const object = await this.bucket.get(key);
			return object ? readStored(NotebookImportItemSchema, object, key) : null;
		});
		const now = Date.now();
		const notebooks = items
			.flatMap((item) =>
				// A preparing receipt whose lease lapsed can be retried, so it reads like an untried entry.
				!item || (item.state === 'preparing' && item.lease_until <= now)
					? []
					: [
							{
								entry_notebook: item.input.entry_notebook,
								state: item.state,
								...(item.state === 'complete' && item.notebook ? { notebook: item.notebook } : {}),
							},
						],
			)
			.sort((a, b) => a.entry_notebook.localeCompare(b.entry_notebook));
		return { id, expires_at: new Date(preparation.expires_at).toISOString(), notebooks };
	}

	async sweep(projectId: ProjectId): Promise<void> {
		const project = paths.project(projectId);
		const now = Date.now();
		for (const object of await listAllObjects(this.bucket, project.notebookImportsPrefix)) {
			if (object.uploaded.getTime() + IMPORT_RETENTION_MS + CLEANUP_GRACE_MS > now) continue;
			const id = object.key.slice(project.notebookImportsPrefix.length).split('/')[0];
			if (!ImportId.is(id)) continue;
			const imp = project.notebookImport(id);
			if (object.key === imp.snapshot) {
				if (!(await this.bucket.head(imp.preparation))) await this.bucket.delete(object.key);
				continue;
			}
			if (object.key !== imp.preparation) continue;
			const preparationObject = await this.bucket.get(imp.preparation);
			if (!preparationObject) continue;
			const preparation = await readStored(
				NotebookImportPreparationSchema,
				preparationObject,
				imp.preparation,
			);
			const purge = preparation.expires_at + IMPORT_PURGE_MS <= now;
			for (const itemObject of await listAllObjects(this.bucket, imp.itemsPrefix)) {
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
				for (const notebookId of item.attempts) {
					if (
						notebookId === item.notebook_id &&
						(item.state === 'publishing' || item.state === 'complete')
					)
						continue;
					await deleteByPrefix(this.bucket, `${project.notebook(notebookId).base}/`);
				}
				if (item.state !== 'publishing') continue;
				if (purge) {
					logOperationalError(
						'notebook_import_publish_abandoned',
						{ projectId, importId: id, notebookId: item.notebook_id },
						new Error('Notebook import publication did not complete before purge'),
					);
					continue;
				}
				try {
					await this.publish(projectId, id, item.input, item.actor);
				} catch (error) {
					logOperationalError(
						'notebook_import_publish_retry_failed',
						{ projectId, notebookId: item.notebook_id },
						error,
					);
				}
			}
			if (purge) await deleteByPrefix(this.bucket, imp.base);
			// Receipts stay until the purge: a replay must not resurrect a deleted or edited notebook.
			else await this.bucket.delete(imp.snapshot);
		}
	}

	/** CAS-advance a `publishing` receipt for `notebookId`; a no-op once anything else won. */
	private async settle(
		key: string,
		notebookId: string,
		next: (current: NotebookImportItem) => NotebookImportItem,
	) {
		await withCasRetry(this.bucket, async (cas) => {
			const object = await this.bucket.get(key);
			if (!object) return;
			const current = await readStored(NotebookImportItemSchema, object, key);
			if (current.state === 'publishing' && current.notebook_id === notebookId)
				await cas.put(key, JSON.stringify(next(current)), { onlyIfEtagMatches: object.etag });
		});
	}

	private async itemKey(imp: NotebookImportPaths, entry: string) {
		validateLocalEntryNotebook(entry);
		return imp.item(await sha256Hex(entry));
	}

	private paths(projectId: ProjectId, id: string) {
		if (!ImportId.is(id)) throw new BadRequestError('Invalid import id');
		return paths.project(projectId).notebookImport(id);
	}

	private async preparation(imp: NotebookImportPaths, actor: UserId) {
		const object = await this.bucket.get(imp.preparation);
		if (!object) throw new NotFoundError('Import not found');
		const preparation = await readStored(NotebookImportPreparationSchema, object, imp.preparation);
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
		const excludedDirectories = folderImportExcludedDirectories([...paths]);
		if (excludedDirectories.includes(''))
			throw new BadRequestError(
				'The selected folder is a virtual environment; choose the project folder instead.',
			);
		for (const file of files) {
			if (isFolderImportExcludedPath(file.path, excludedDirectories))
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
