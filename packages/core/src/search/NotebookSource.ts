import { MAX_SEARCH_TEXT_LENGTH } from './limits';
import { NotFoundError } from '../errors';
import { htmlText } from './text';
import type { Bucket } from '../ports/bucket';
import type { CatalogService } from '../services/catalog/CatalogService';
import type { NotebookService } from '../services/content/NotebookService';
import type { AuthorizationService } from '../services/authorization/AuthorizationService';
import type { AuthenticatedPrincipal } from '../ports/auth';
import type { Project } from '../schema';
import { NotebookMetaSchema, SourceSchema } from '../schema';
import { paths } from '../paths';
import { remoteWorkspaceEntry, workspaceSourcePolicy } from '../integrations/remoteWorkspace';
import { sha256Hex } from '../internal/sha256';
import { mapWithConcurrency } from '../concurrency';
import type { SearchDocument, SearchSource } from './contracts';

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
export class NotebookSource implements SearchSource {
	readonly revision = 2;
	readonly id = 'notebooks';
	readonly kinds = ['notebook', 'code', 'output'] as const;
	constructor(
		private readonly bucket: Bucket,
		private readonly catalog: CatalogService,
		private readonly notebooks: NotebookService,
		private readonly authz: AuthorizationService,
	) {}
	private async source(
		project: Project,
		notebookId: Parameters<NotebookService['getNotebookMeta']>[1],
		signal: AbortSignal,
	) {
		signal.throwIfAborted();
		const nb = paths.project(project.id).notebook(notebookId);
		const [metaObject, sourceObject] = await Promise.all([
			this.bucket.get(nb.meta),
			this.bucket.get(nb.source),
		]);
		if (!metaObject || metaObject.size > MAX_ARTIFACT_BYTES)
			throw new Error('Notebook metadata is missing or exceeds the read budget');
		const meta = NotebookMetaSchema.parse(await metaObject.json());
		if (meta.id !== notebookId || meta.project_id !== project.id)
			throw new Error('Notebook identity mismatch');
		if (meta.status === 'deleted' || meta.preview) return null;
		if (!sourceObject || sourceObject.size > MAX_ARTIFACT_BYTES)
			throw new Error('Notebook source is missing or exceeds the read budget');
		const source = SourceSchema.parse(await sourceObject.json());
		const remote = remoteWorkspaceEntry(source);
		const codeKey = remote
			? source.current_version_id
				? nb.version(source.current_version_id).workspaceFile(remote)
				: undefined
			: nb.workspaceFile(workspaceSourcePolicy(source).entryNotebook);
		const outputKey = source.current_version_id
			? nb.version(source.current_version_id).session
			: undefined;
		const [code, session, html] = await Promise.all([
			codeKey ? this.bucket.head(codeKey) : null,
			outputKey ? this.bucket.head(outputKey) : null,
			source.current_version_id
				? this.bucket.head(nb.version(source.current_version_id).html)
				: null,
		]);
		const output = session ?? html;
		return {
			meta,
			code,
			output,
			fingerprint: await sha256Hex(
				JSON.stringify([metaObject.etag, sourceObject.etag, code?.etag, output?.etag]),
			),
		};
	}
	async page(project: Project, cursor: string | undefined, signal: AbortSignal) {
		const snapshot = await this.catalog.getCurrentSnapshot();
		const entries =
			snapshot.projects
				.find((p) => p.id === project.id)
				?.notebooks.filter((n) => n.status !== 'deleted' && (!cursor || n.id > cursor))
				.sort((a, b) => a.id.localeCompare(b.id)) ?? [];
		const batch = entries.slice(0, 25);
		let partial = false;
		const groups = await mapWithConcurrency(batch, 4, async (entry) => {
			signal.throwIfAborted();
			try {
				const source = await this.source(project, entry.id, signal);
				if (!source) return [];
				const base = {
					resource: { type: 'notebook' as const, notebook_id: entry.id },
					title: source.meta.title.slice(0, 256),
					fingerprint: source.fingerprint,
				};
				const docs: SearchDocument[] = [
					{
						...base,
						id: `${entry.id}:notebook`,
						kind: 'notebook',
						text: `${source.meta.title}\n${htmlText(source.meta.description)}`.slice(
							0,
							MAX_SEARCH_TEXT_LENGTH,
						),
					},
				];
				for (const kind of ['code', 'output'] as const) {
					const head = source[kind];
					if (!head) continue;
					if (head.size > MAX_ARTIFACT_BYTES) {
						partial = true;
						continue;
					}
					signal.throwIfAborted();
					const object = await this.bucket.get(head.key);
					if (!object || object.etag !== head.etag || object.size > MAX_ARTIFACT_BYTES) {
						partial = true;
						continue;
					}
					let text = await object.text();
					if (kind === 'output') {
						try {
							text = head.key.endsWith('/session.json') ? savedOutputText(text) : htmlText(text);
						} catch {
							partial = true;
							continue;
						}
					}
					partial ||= text.length > MAX_SEARCH_TEXT_LENGTH;
					if (text)
						docs.push({
							...base,
							id: `${entry.id}:${kind}`,
							kind,
							text: text.slice(0, MAX_SEARCH_TEXT_LENGTH),
						});
				}
				return docs;
			} catch {
				signal.throwIfAborted();
				partial = true;
				return [];
			}
		});
		return {
			documents: groups.flat(),
			cursor: entries.length > batch.length ? batch.at(-1)!.id : undefined,
			partial,
		};
	}
	async validate(
		project: Project,
		documents: SearchDocument[],
		principal: AuthenticatedPrincipal,
		phase: 'rank' | 'return',
		signal: AbortSignal,
	) {
		const ids = [
			...new Set(
				documents.flatMap((d) => (d.resource.type === 'notebook' ? [d.resource.notebook_id] : [])),
			),
		];
		const allowed = new Map<string, string | null>();
		await mapWithConcurrency(ids, 8, async (id) => {
			signal.throwIfAborted();
			try {
				const meta = await this.notebooks.getNotebookMeta(project.id, id, {
					consistency: 'validated',
				});
				if (meta.preview || meta.status === 'deleted') return;
				const decision = await this.authz.authorize(principal, 'project.read', {
					kind: 'project',
					project,
					notebookLabels: meta.security_labels,
				});
				if (!decision.allowed) return;
				signal.throwIfAborted();
				const current = phase === 'return' ? await this.source(project, id, signal) : null;
				if (phase === 'return' && !current) return;
				allowed.set(id, current?.fingerprint ?? null);
			} catch (error) {
				signal.throwIfAborted();
				if (!(error instanceof NotFoundError)) throw error;
			}
		});
		const validated = documents.filter(
			(d) =>
				d.resource.type === 'notebook' &&
				allowed.has(d.resource.notebook_id) &&
				(phase === 'rank' || allowed.get(d.resource.notebook_id) === d.fingerprint),
		);
		return { documents: validated, partial: validated.length !== documents.length };
	}
}
export function savedOutputText(text: string): string {
	const session = JSON.parse(text) as {
		cells?: { outputs?: { type?: string; data?: Record<string, unknown> }[] }[];
	};
	if (!Array.isArray(session.cells)) return '';
	const out: string[] = [];
	for (const cell of session.cells)
		for (const output of Array.isArray(cell.outputs) ? cell.outputs : []) {
			if (output?.type !== 'data') continue;
			const plain = output.data?.['text/plain'];
			const html = output.data?.['text/html'];
			if (typeof plain === 'string') out.push(plain);
			else if (typeof html === 'string') out.push(htmlText(html));
		}
	return out.join('\n');
}
