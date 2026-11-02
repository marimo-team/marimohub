import { MAX_SEARCH_TEXT_LENGTH, MAX_SEARCH_CURSOR_LENGTH } from './limits';
import { sha256Hex } from '../internal/sha256';
import { withDeadline } from '../async';
import { z } from 'zod';
import type { ProjectIntegrationsService } from '../services/integrations/contracts';
import type { AuthorizationService } from '../services/authorization/AuthorizationService';
import type { AuthenticatedPrincipal } from '../ports/auth';
import type { Project } from '../schema';
import { IntegrationIdSchema } from '../schema';
import type { SearchDocument, SearchSource } from './contracts';

const TaskSchema = z.object({
	id: IntegrationIdSchema,
	version: z.number().int().positive(),
	updatedAt: z.string(),
	kind: z.enum(['namespaces', 'tables', 'columns']),
	namespace: z.array(z.string()).default([]),
	cursor: z.string().optional(),
	table: z.string().optional(),
});
const CursorSchema = z.object({
	after: z.string(),
	queue: z.array(TaskSchema).max(500),
	seen: z.array(z.string()).max(500),
	partial: z.boolean(),
});
export class IntegrationSource implements SearchSource {
	readonly revision = 1;
	get configuration() {
		return JSON.stringify({ schemas: this.schemas });
	}
	readonly id = 'data';
	readonly kinds: readonly SearchDocument['kind'][];
	constructor(
		private readonly integrations: ProjectIntegrationsService,
		private readonly authz: AuthorizationService,
		private readonly schemas: boolean,
	) {
		this.kinds = schemas ? ['datasource', 'namespace', 'table', 'column'] : ['datasource'];
	}
	async page(project: Project, cursor: string | undefined, signal: AbortSignal) {
		const state = cursor
			? CursorSchema.parse(JSON.parse(cursor))
			: { after: '', queue: [], seen: [], partial: false };
		const entries = (await this.integrations.list(project.id, { maxHeads: 500, signal }))
			.filter((e) => e.enabled && !e.shadowed)
			.sort((a, b) => a.id.localeCompare(b.id));
		const documents: SearchDocument[] = [];
		if (state.queue.length === 0) {
			const entry = entries.find((e) => e.id > state.after);
			if (!entry) return { documents, partial: state.partial };
			state.after = entry.id;
			documents.push({
				id: `${entry.id}:datasource`,
				kind: 'datasource',
				resource: { type: 'integration', integration_id: entry.id, version: entry.current_version },
				title: entry.name.slice(0, 256),
				text: `${entry.name} ${entry.kind}`.slice(0, MAX_SEARCH_TEXT_LENGTH),
				fingerprint: `${entry.current_version}:${entry.updated_at}`,
			});
			if (
				this.schemas &&
				this.integrations
					.listKinds()
					.find((k) => k.kind === entry.kind)
					?.browse_surfaces.includes('tables')
			)
				state.queue.push({
					id: entry.id,
					version: entry.current_version,
					updatedAt: entry.updated_at,
					kind: 'namespaces',
					namespace: [],
				});
		}
		// One catalog call per page makes both the probe budget and restart position explicit.
		const task = state.queue.shift();
		if (task) {
			try {
				await withDeadline(
					async (signal) => {
						signal.throwIfAborted();
						if (!entries.some((e) => e.id === task.id && e.current_version === task.version))
							state.partial = true;
						else {
							const resource = {
								type: 'integration' as const,
								integration_id: task.id,
								version: task.version,
							};
							const add = async (
								kind: SearchDocument['kind'],
								title: string,
								namespace: string[],
								table?: string,
								column?: string,
								text = title,
							) => {
								documents.push({
									id: await sha256Hex(JSON.stringify([task.id, kind, namespace, table, column])),
									kind,
									resource: { ...resource, namespace, table, column },
									title: title.slice(0, 256),
									text: text.slice(0, MAX_SEARCH_TEXT_LENGTH),
									fingerprint: `${task.version}:${task.updatedAt}`,
								});
							};
							if (task.kind === 'namespaces') {
								const page = await this.integrations.browseNamespaces(project.id, task.id, {
									parent: task.namespace.length > 0 ? task.namespace : undefined,
									cursor: task.cursor,
									limit: 25,
									signal,
								});
								signal.throwIfAborted();
								state.partial ||= page.items.length > 25;
								for (const ns of page.items.slice(0, 25)) {
									const key = JSON.stringify([task.id, ns]);
									if (state.seen.includes(key)) continue;
									if (state.seen.length === 500) {
										state.partial = true;
										break;
									}
									state.seen.push(key);
									await add('namespace', ns.join('.'), ns);
									state.queue.push(
										{ ...task, namespace: ns, cursor: undefined },
										{ ...task, kind: 'tables', namespace: ns, cursor: undefined },
									);
								}
								if (page.next_cursor && page.next_cursor !== task.cursor)
									state.queue.push({ ...task, cursor: page.next_cursor });
								else if (page.next_cursor) state.partial = true;
							} else if (task.kind === 'tables') {
								const page = await this.integrations.browseTables(
									project.id,
									task.id,
									task.namespace,
									{
										cursor: task.cursor,
										limit: 25,
										signal,
									},
								);
								signal.throwIfAborted();
								state.partial ||= page.items.length > 25;
								for (const table of page.items.slice(0, 25)) {
									await add('table', table, task.namespace, table);
									state.queue.push({ ...task, kind: 'columns', table, cursor: undefined });
								}
								if (page.next_cursor && page.next_cursor !== task.cursor)
									state.queue.push({ ...task, cursor: page.next_cursor });
								else if (page.next_cursor) state.partial = true;
							} else if (task.table) {
								const schema = await this.integrations.browseTableSchema(
									project.id,
									task.id,
									task.namespace,
									task.table,
									{ signal },
								);
								signal.throwIfAborted();
								for (const column of schema.columns.slice(0, 100))
									await add(
										'column',
										column.name,
										task.namespace,
										task.table,
										column.name,
										`${column.name}: ${column.type}`,
									);
								state.partial ||= schema.columns.length > 100;
							}
						}
					},
					{ timeoutMs: 2000, timeoutError: () => new Error('Catalog deadline'), signal },
				);
			} catch {
				signal.throwIfAborted();
				state.partial = true;
			}
		}
		if (state.queue.length > 500) {
			state.queue = state.queue.slice(0, 500);
			state.partial = true;
		}
		const next =
			state.queue.length > 0 || entries.some((e) => e.id > state.after)
				? JSON.stringify(state)
				: undefined;
		if (next && next.length > MAX_SEARCH_CURSOR_LENGTH) return { documents, partial: true };
		return { documents, cursor: next, partial: state.partial };
	}
	async validate(
		project: Project,
		documents: SearchDocument[],
		principal: AuthenticatedPrincipal,
		_phase: 'rank' | 'return',
		signal: AbortSignal,
	) {
		if (
			!(await this.authz.authorize(principal, 'integration.use', { kind: 'project', project }))
				.allowed
		)
			return { documents: [], partial: false };
		const entries = (await this.integrations.list(project.id, { maxHeads: 500, signal })).filter(
			(e) => e.enabled && !e.shadowed,
		);
		const valid: SearchDocument[] = [];
		const tables = new Map<
			string,
			Awaited<ReturnType<ProjectIntegrationsService['browseTableSchema']>>
		>();
		const namespaces = new Map<string, string[][]>();
		const truncatedNamespaces = new Set<string>();
		let probes = 0;
		let partial = false;
		for (const doc of documents) {
			signal.throwIfAborted();
			const ref = doc.resource;
			if (
				ref.type !== 'integration' ||
				!entries.some(
					(e) =>
						e.id === ref.integration_id &&
						`${e.current_version}:${e.updated_at}` === doc.fingerprint,
				)
			)
				continue;
			if (doc.kind === 'datasource') {
				valid.push(doc);
				continue;
			}
			if (!this.schemas) continue;
			const key = JSON.stringify([ref.integration_id, ref.namespace, ref.table]);
			if (ref.table && ref.namespace) {
				let schema = tables.get(key);
				if (!schema) {
					if (probes === 32) {
						partial = true;
						continue;
					}
					probes++;
					schema = await this.integrations.browseTableSchema(
						project.id,
						ref.integration_id,
						ref.namespace,
						ref.table,
						{ query_user: principal.email, signal },
					);
					tables.set(key, schema);
				}
				if (
					ref.column &&
					!schema.columns.some(
						(c) =>
							c.name === ref.column &&
							`${c.name}: ${c.type}`.slice(0, MAX_SEARCH_TEXT_LENGTH) === doc.text,
					)
				)
					continue;
				valid.push(doc);
			} else if (ref.namespace) {
				const parent = ref.namespace.slice(0, -1);
				const key = JSON.stringify([ref.integration_id, parent]);
				let names = namespaces.get(key);
				if (!names) {
					if (probes === 32) {
						partial = true;
						continue;
					}
					probes++;
					const page = await this.integrations.browseNamespaces(project.id, ref.integration_id, {
						parent: parent.length > 0 ? parent : undefined,
						limit: 100,
						query_user: principal.email,
						signal,
					});
					names = page.items;
					if (page.next_cursor) truncatedNamespaces.add(key);
					namespaces.set(key, names);
				}
				if (names.some((n) => JSON.stringify(n) === JSON.stringify(ref.namespace))) valid.push(doc);
				else if (truncatedNamespaces.has(key)) partial = true;
			}
		}
		return { documents: valid, partial };
	}
}
