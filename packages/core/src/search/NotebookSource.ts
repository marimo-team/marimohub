import { MAX_SEARCH_TEXT_LENGTH } from './limits';
import { NotFoundError } from '../errors';
import { htmlText } from './text';
import type { Bucket } from '../ports/bucket';
import type { CatalogService } from '../services/catalog/CatalogService';
import type { NotebookService } from '../services/content/NotebookService';
import { assertNotMoving } from '../services/content/notebookMoveRecord';
import type { AuthorizationService } from '../services/authorization/AuthorizationService';
import type { AuthenticatedPrincipal } from '../ports/auth';
import type { Project } from '../schema';
import { NotebookMetaSchema, SourceSchema } from '../schema';
import { paths } from '../paths';
import { remoteWorkspaceEntry, workspaceSourcePolicy } from '../integrations/remoteWorkspace';
import { sha256Hex } from '../internal/sha256';
import { mapWithConcurrency } from '../concurrency';
import type { SearchDocument, SearchSnapshot, SearchSource } from './contracts';

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_HTML_LENGTH = 32 * 1024;
export class NotebookSource implements SearchSource {
	readonly revision = 3;
	readonly id = 'notebooks';
	readonly embeddable = true;
	readonly incremental = true;
	readonly catalogBacked = true;
	readonly kinds = ['notebook', 'code', 'output'] as const;
	constructor(
		private readonly bucket: Bucket,
		private readonly catalog: CatalogService,
		_notebooks: NotebookService,
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
		if (!metaObject) throw new NotFoundError('Notebook metadata is missing');
		if (metaObject.size > MAX_ARTIFACT_BYTES)
			throw new Error('Notebook metadata exceeds the read budget');
		const meta = NotebookMetaSchema.parse(await metaObject.json());
		if (meta.id !== notebookId || meta.project_id !== project.id)
			throw new Error('Notebook identity mismatch');
		assertNotMoving(meta, notebookId);
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
		const [code, session] = await Promise.all([
			codeKey ? this.bucket.head(codeKey) : null,
			outputKey ? this.bucket.head(outputKey) : null,
		]);
		const output =
			session ??
			(source.current_version_id
				? await this.bucket.head(nb.version(source.current_version_id).html)
				: null);
		return {
			meta,
			code,
			output,
			reusable: [metaObject, sourceObject, code, output].every((object) => !object || object.etag),
			fingerprint: await sha256Hex(
				JSON.stringify([
					metaObject.etag,
					sourceObject.etag,
					code?.key,
					code?.etag,
					output?.key,
					output?.etag,
				]),
			),
		};
	}
	async page(
		project: Project,
		cursor: string | undefined,
		signal: AbortSignal,
		previous?: SearchSnapshot | null,
	) {
		const reusable = new Map<string, SearchDocument[]>();
		if (previous)
			for (const document of previous.documents) {
				if (document.resource.type !== 'notebook') continue;
				const id = document.resource.notebook_id;
				const group = reusable.get(id) ?? [];
				group.push(document);
				reusable.set(id, group);
			}
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
				const old = reusable.get(entry.id);
				const stored = old?.[0] && parseNotebookFingerprint(old[0].fingerprint);
				if (
					source.reusable &&
					old &&
					stored?.content === source.fingerprint &&
					stored.count === old.length &&
					(stored.coverage === 'complete' || stored.coverage === 'partial') &&
					old.every((doc) => doc.fingerprint === old[0].fingerprint)
				) {
					partial ||= stored.coverage === 'partial';
					return old;
				}
				let incomplete = false;
				let retry = false;
				const truncated = () => {
					incomplete = true;
				};
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
						text: `${source.meta.title}\n${boundedHtmlText(source.meta.description, truncated)}`.slice(
							0,
							MAX_SEARCH_TEXT_LENGTH,
						),
					},
				];
				for (const kind of ['code', 'output'] as const) {
					const head = source[kind];
					if (!head) continue;
					if (head.size > MAX_ARTIFACT_BYTES) {
						incomplete = true;
						continue;
					}
					signal.throwIfAborted();
					const object = await this.bucket.get(head.key);
					if (!object || object.etag !== head.etag || object.size > MAX_ARTIFACT_BYTES) {
						incomplete = retry = true;
						continue;
					}
					let text = await object.text();
					if (kind === 'output') {
						try {
							text = head.key.endsWith('/session.json')
								? savedOutputText(text, truncated)
								: boundedHtmlText(text, truncated);
						} catch {
							incomplete = retry = true;
							continue;
						}
					}
					incomplete ||= text.length > MAX_SEARCH_TEXT_LENGTH;
					if (text)
						docs.push({
							...base,
							id: `${entry.id}:${kind}`,
							kind,
							text: text.slice(0, MAX_SEARCH_TEXT_LENGTH),
						});
				}
				const coverage = retry ? 'retry' : incomplete ? 'partial' : 'complete';
				const fingerprint = `${source.fingerprint}:${docs.length}:${coverage}`;
				for (const doc of docs) doc.fingerprint = fingerprint;
				partial ||= incomplete;
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
		signal.throwIfAborted();
		// SearchService checks the selected page before exposing any results.
		if (phase === 'rank') return { documents, partial: false };
		const ids = [
			...new Set(
				documents.flatMap((d) => (d.resource.type === 'notebook' ? [d.resource.notebook_id] : [])),
			),
		];
		const allowed = new Map<string, string>();
		await mapWithConcurrency(ids, 8, async (id) => {
			signal.throwIfAborted();
			try {
				const current = await this.source(project, id, signal);
				if (!current) return;
				const decision = await this.authz.authorize(principal, 'project.read', {
					kind: 'project',
					project,
					notebookLabels: current.meta.security_labels,
				});
				if (!decision.allowed) return;
				signal.throwIfAborted();
				allowed.set(id, current.fingerprint);
			} catch (error) {
				signal.throwIfAborted();
				if (!(error instanceof NotFoundError)) throw error;
			}
		});
		const validated = documents.filter(
			(d) =>
				d.resource.type === 'notebook' &&
				allowed.has(d.resource.notebook_id) &&
				allowed.get(d.resource.notebook_id) === parseNotebookFingerprint(d.fingerprint).content,
		);
		return { documents: validated, partial: validated.length !== documents.length };
	}
}

// Group size detects incomplete snapshots. Coverage distinguishes truncation from failed reads.
function parseNotebookFingerprint(value: string) {
	const [content, count, coverage] = value.split(':');
	return { content, count: Number(count), coverage };
}

function boundedHtmlText(value: string, truncated: () => void): string {
	if (value.length > MAX_HTML_LENGTH) truncated();
	return htmlText(value.slice(0, MAX_HTML_LENGTH));
}

export function savedOutputText(text: string, truncated: () => void = () => {}): string {
	const session = JSON.parse(text) as {
		cells?: { outputs?: { type?: string; data?: Record<string, unknown> }[] }[];
	};
	if (!Array.isArray(session.cells)) return '';
	const out: string[] = [];
	let remaining = MAX_HTML_LENGTH;
	for (const cell of session.cells)
		for (const output of Array.isArray(cell.outputs) ? cell.outputs : []) {
			if (output?.type !== 'data') continue;
			const plain = output.data?.['text/plain'];
			const html = output.data?.['text/html'];
			const value = typeof plain === 'string' ? plain : html;
			if (typeof value !== 'string') continue;
			if (value.length > remaining) truncated();
			if (remaining === 0) continue;
			const bounded = value.slice(0, remaining);
			out.push(typeof plain === 'string' ? bounded : htmlText(bounded));
			remaining -= bounded.length;
		}
	return out.join('\n');
}
