import { ulid } from 'ulidx';
import type { Bucket } from '../../ports/bucket';
import type { Metrics } from '../../ports/metrics';
import { noopMetrics } from '../../ports/metrics';
import { DeepLinkRecordSchema, DeepLinkSlugSchema, isPublicDeepLink } from '../../deepLinks';
import type { DeepLink, DeepLinkAccess, DeepLinkTarget } from '../../deepLinks';
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
	async moveNotebook(source: ProjectId, destination: ProjectId, nid: NotebookId): Promise<void> {
		const prefix = paths.project(source).notebook(nid).deepLinksPrefix;
		for (const key of await listAllKeys(this.bucket, prefix)) {
			const slug = key.slice(prefix.length).replace(/\.json$/, '');
			await putIfAbsent(
				this.bucket,
				paths.project(destination).notebook(nid).deepLinkIndex(slug),
				'',
			);
			await withCasRetry(this.bucket, async (cas) => {
				const current = await this.read(slug);
				if (
					!current ||
					'released' in current.record ||
					current.record.target.project_id !== source ||
					current.record.target.notebook_id !== nid
				)
					return;
				await cas.put(
					paths.deepLink(slug),
					JSON.stringify({
						...current.record,
						// Cross-project moves always demote public links so destination managers must re-consent.
						access: { mode: 'inherit' },
						target: { ...current.record.target, project_id: destination },
					}),
					{ onlyIfEtagMatches: current.etag },
				);
			});
		}
	}

	constructor(
		private bucket: Bucket,
		private metrics: Metrics = noopMetrics,
	) {}

	private slug(value: string): string {
		const result = DeepLinkSlugSchema.safeParse(value);
		if (!result.success)
			throw new ValidationError(
				'Use 1–63 characters: lowercase letters, digits, or hyphens in slash-separated segments. Start and end each segment with a letter or digit.',
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

	async resolvePublic(
		slug: string,
	): Promise<DeepLink & { access: DeepLinkAccess & { mode: 'public' } }> {
		const link = await this.resolve(slug);
		if (!isPublicDeepLink(link)) throw new NotFoundError('App link not found');
		return link;
	}

	async setAccess(
		slug: string,
		target: DeepLinkTarget,
		registrationId: string,
		input: { mode: 'inherit' } | { mode: 'public'; allow_project_integrations?: boolean },
		actor: UserId,
	): Promise<{ link: DeepLink; changed: boolean; wasPublic: boolean }> {
		const canonical = this.slug(slug);
		return withCasRetry(this.bucket, async (cas) => {
			const current = await this.read(canonical);
			if (!current || 'released' in current.record || !sameTarget(current.record.target, target)) {
				throw new NotFoundError('App link not found');
			}
			if (current.record.registration_id !== registrationId) {
				throw new ConflictError('App link registration has changed; refresh and try again');
			}
			const wasPublic = current.record.access.mode === 'public';
			if (input.mode === 'inherit') {
				if (!wasPublic) return { link: current.record, changed: false, wasPublic: false };
				const next: DeepLink = {
					...current.record,
					access: { mode: 'inherit' },
				};
				await cas.put(paths.deepLink(canonical), JSON.stringify(next), {
					onlyIfEtagMatches: current.etag,
				});
				return { link: next, changed: true, wasPublic: true };
			}
			const wantIntegrations = input.allow_project_integrations === true;
			const hasIntegrations = current.record.access.allow_project_integrations === true;
			if (wasPublic && hasIntegrations === wantIntegrations) {
				return { link: current.record, changed: false, wasPublic: true };
			}
			const nextAccess: DeepLinkAccess = {
				mode: 'public',
				grant_id: ulid(),
				enabled_by: actor,
				enabled_at: new Date().toISOString(),
				...(wantIntegrations ? { allow_project_integrations: true } : {}),
			};
			const next: DeepLink = {
				...current.record,
				access: nextAccess,
			};
			await cas.put(paths.deepLink(canonical), JSON.stringify(next), {
				onlyIfEtagMatches: current.etag,
			});
			return { link: next, changed: true, wasPublic };
		});
	}

	async downgradeNotebookPublicLinks(
		projectId: ProjectId,
		notebookId: NotebookId,
	): Promise<number> {
		const target: DeepLinkTarget = { kind: 'app', project_id: projectId, notebook_id: notebookId };
		const links = await this.list(target);
		let downgraded = 0;
		await mapWithConcurrency(links, BUCKET_SCAN_CONCURRENCY, async (link) => {
			if (link.access.mode !== 'public') return;
			await withCasRetry(this.bucket, async (cas) => {
				const current = await this.read(link.slug);
				if (
					!current ||
					'released' in current.record ||
					current.record.registration_id !== link.registration_id ||
					!sameTarget(current.record.target, target) ||
					current.record.access.mode !== 'public'
				) {
					return;
				}
				const next: DeepLink = { ...current.record, access: { mode: 'inherit' } };
				await cas.put(paths.deepLink(link.slug), JSON.stringify(next), {
					onlyIfEtagMatches: current.etag,
				});
				downgraded++;
			});
		});
		return downgraded;
	}

	async downgradeProjectPublicLinks(projectId: ProjectId): Promise<NotebookId[]> {
		const prefix = `${paths.project(projectId).meta.replace(/project\.json$/, '')}notebooks/`;
		const notebooks = await listAllPrefixes(this.bucket, prefix);
		const affected: NotebookId[] = [];
		await mapWithConcurrency(notebooks, BUCKET_SCAN_CONCURRENCY, async (key) => {
			const id = key.slice(prefix.length).replace(/\/$/, '');
			if (!NotebookId.is(id)) return;
			const count = await this.downgradeNotebookPublicLinks(projectId, id);
			if (count > 0) affected.push(id);
		});
		return affected;
	}

	async hasPublicLinks(
		projectId: ProjectId,
		notebookId: NotebookId,
		variant: 'any' | 'default' | 'integrations' = 'any',
	): Promise<boolean> {
		const links = await this.list({ kind: 'app', project_id: projectId, notebook_id: notebookId });
		return links.some((link) => {
			if (!isPublicDeepLink(link)) return false;
			if (variant === 'any') return true;
			const hasIntegrations = link.access.allow_project_integrations === true;
			return variant === 'integrations' ? hasIntegrations : !hasIntegrations;
		});
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
