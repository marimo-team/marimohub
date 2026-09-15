import { ulid } from 'ulidx';
import type { Bucket } from '../../ports/bucket';
import type { Metrics } from '../../ports/metrics';
import { noopMetrics } from '../../ports/metrics';
import { DeepLinkRecordSchema, DeepLinkSlugSchema } from '../../deepLinks';
import type { DeepLink, DeepLinkTarget } from '../../deepLinks';
import { ConflictError, NotFoundError, ValidationError } from '../../errors';
import { NotebookId } from '../../ids';
import type { ProjectId, UserId } from '../../ids';
import { paths } from '../../paths';
import { NotebookMetaSchema, ProjectSchema, readStored } from '../../schema';
import { BUCKET_SCAN_CONCURRENCY } from '../../constants';
import { mapWithConcurrency } from '../../concurrency';
import { putIfAbsent, withCasRetry } from '../catalog/cas';
import { listAllKeys, listAllPrefixes } from '../catalog/storage';

function sameTarget(a: DeepLinkTarget, b: DeepLinkTarget): boolean {
	return a.kind === b.kind && a.project_id === b.project_id && a.notebook_id === b.notebook_id;
}

export class DeepLinkService {
	constructor(
		private bucket: Bucket,
		private metrics: Metrics = noopMetrics,
	) {}

	private slug(value: string): string {
		const result = DeepLinkSlugSchema.safeParse(value);
		if (!result.success)
			throw new ValidationError(
				'Use 1–63 lowercase letters, digits, or hyphens, starting and ending with a letter or digit.',
			);
		return result.data;
	}

	private async read(slug: string) {
		const key = paths.deepLink(this.slug(slug));
		const object = await this.bucket.get(key);
		if (!object) return null;
		return { record: await readStored(DeepLinkRecordSchema, object, key), etag: object.etag };
	}

	private async targetExists(target: DeepLinkTarget): Promise<boolean> {
		const projectKey = paths.project(target.project_id).meta;
		const notebookKey = paths.project(target.project_id).notebook(target.notebook_id).meta;
		const [project, notebook] = await Promise.all([
			this.bucket.get(projectKey),
			this.bucket.get(notebookKey),
		]);
		if (!project || !notebook) return false;
		const [projectMeta, notebookMeta] = await Promise.all([
			readStored(ProjectSchema, project, projectKey),
			readStored(NotebookMetaSchema, notebook, notebookKey),
		]);
		return projectMeta.status !== 'deleted' && notebookMeta.status !== 'deleted';
	}

	async resolve(slug: string): Promise<DeepLink> {
		const started = Date.now();
		try {
			const current = await this.read(slug);
			if (
				!current ||
				'released' in current.record ||
				!(await this.targetExists(current.record.target))
			) {
				throw new NotFoundError('App link not found');
			}
			return current.record;
		} catch (error) {
			this.metrics.increment('deep_links.resolve_errors', 1, {
				kind: error instanceof NotFoundError ? 'not_found' : 'error',
			});
			throw error;
		} finally {
			this.metrics.histogram?.('deep_links.resolve_latency_ms', Date.now() - started);
		}
	}

	async register(slug: string, target: DeepLinkTarget, actor: UserId): Promise<DeepLink> {
		this.slug(slug);
		if (!(await this.targetExists(target))) throw new NotFoundError('Notebook not found');
		// Index first: a crash can leave a candidate, but never an undiscoverable live registration.
		await putIfAbsent(
			this.bucket,
			paths.project(target.project_id).notebook(target.notebook_id).deepLinkIndex(slug),
			'',
		);
		const next: DeepLink = {
			schema_version: 1,
			registration_id: ulid(),
			slug,
			target,
			access: { mode: 'inherit' },
			created_by: actor,
			created_at: new Date().toISOString(),
		};
		const link = await withCasRetry(
			this.bucket,
			async (cas) => {
				const current = await this.read(slug);
				if (current && !('released' in current.record)) {
					if (sameTarget(current.record.target, target)) return current.record;
					if (await this.targetExists(current.record.target)) {
						this.metrics.increment('deep_links.registration_conflicts');
						throw new ConflictError('This app slug is already registered');
					}
				}
				await cas.put(
					paths.deepLink(slug),
					JSON.stringify(next),
					current ? { onlyIfEtagMatches: current.etag } : { onlyIfNotExists: true },
				);
				return next;
			},
			{ onConflict: () => this.metrics.increment('deep_links.registration_conflicts') },
		);
		if (!(await this.targetExists(target))) {
			await this.release(slug, target, link.registration_id);
			throw new NotFoundError('Notebook not found');
		}
		return link;
	}

	async release(slug: string, target: DeepLinkTarget, registrationId: string): Promise<void> {
		await withCasRetry(this.bucket, async (cas) => {
			const current = await this.read(slug);
			if (!current || 'released' in current.record) return;
			if (
				current.record.registration_id !== registrationId ||
				!sameTarget(current.record.target, target)
			)
				return;
			// Keep a unique free marker: an unconditional DELETE could erase a replacement owner.
			await cas.put(
				paths.deepLink(slug),
				JSON.stringify({ schema_version: 1, released: true, registration_id: registrationId }),
				{ onlyIfEtagMatches: current.etag },
			);
		});
	}

	async list(target: DeepLinkTarget): Promise<DeepLink[]> {
		const prefix = paths.project(target.project_id).notebook(target.notebook_id).deepLinksPrefix;
		const keys = await listAllKeys(this.bucket, prefix);
		const candidates = await mapWithConcurrency(keys, BUCKET_SCAN_CONCURRENCY, async (key) => {
			const slug = key.slice(prefix.length).replace(/\.json$/, '');
			const current = await this.read(slug);
			return current && !('released' in current.record) && sameTarget(current.record.target, target)
				? current.record
				: null;
		});
		return candidates.filter((link): link is DeepLink => link !== null);
	}

	async releaseNotebook(projectId: ProjectId, notebookId: NotebookId): Promise<void> {
		const target: DeepLinkTarget = { kind: 'app', project_id: projectId, notebook_id: notebookId };
		const links = await this.list(target);
		await mapWithConcurrency(links, BUCKET_SCAN_CONCURRENCY, (link) =>
			this.release(link.slug, target, link.registration_id),
		);
	}

	async releaseProject(projectId: ProjectId): Promise<void> {
		const prefix = `${paths.project(projectId).meta.replace(/project\.json$/, '')}notebooks/`;
		const notebooks = await listAllPrefixes(this.bucket, prefix);
		await mapWithConcurrency(notebooks, BUCKET_SCAN_CONCURRENCY, async (key) => {
			const id = key.slice(prefix.length).replace(/\/$/, '');
			if (NotebookId.is(id)) await this.releaseNotebook(projectId, id);
		});
	}
}
