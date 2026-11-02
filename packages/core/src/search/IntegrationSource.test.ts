import { describe, expect, it, vi } from 'vitest';
import { IntegrationSource } from './IntegrationSource';
import { SearchIndexer } from './SearchIndexer';
import { resourceHref } from './rank';
import { MAX_SEARCH_CHECKPOINT_BYTES } from './limits';
import { searchPaths } from './paths';
import { createServices } from '../services';
import { MemoryBucket } from '../testing/MemoryBucket';
import { MemorySearchIndex } from '../testing/search';
import type { ProjectIntegrationsService } from '../services/integrations/contracts';
import type { IntegrationEntry } from '../ports/integrations';
import type { SearchDocument } from './contracts';
import { AuthorizationService } from '../services/authorization/AuthorizationService';
import { makeProject, ACTOR } from '../testing/fixtures';
import { createIntegrationId, UserId } from '../ids';
import type { AuthenticatedPrincipal } from '../ports/auth';
const signal = new AbortController().signal;
const principal: AuthenticatedPrincipal = {
	id: ACTOR,
	email: 'reader@example.com',
	credential: { kind: 'development' },
};
function setup() {
	const project = makeProject();
	const entry = {
		id: createIntegrationId(),
		name: 'Warehouse',
		kind: 'iceberg-rest',
		enabled: true,
		current_version: 1,
		updated_at: '2026-11-02T00:00:00.000Z',
	} as IntegrationEntry;
	const integrations = {
		list: vi.fn(async () => [entry]),
		listKinds: () => [{ kind: entry.kind, browse_surfaces: ['tables'] }],
		browseNamespaces: vi.fn(async () => ({
			items: [['sales']],
			next_cursor: null as string | null,
		})),
		browseTables: vi.fn(async () => ({ items: ['orders'], next_cursor: null as string | null })),
		browseTableSchema: vi.fn(async () => ({
			columns: [{ name: 'revenue', type: 'DOUBLE', nullable: true }],
		})),
	};
	const source = new IntegrationSource(
		integrations as unknown as ProjectIntegrationsService,
		new AuthorizationService({}),
		true,
	);
	return { project, entry, integrations, source };
}
function tableDocument(entry: IntegrationEntry, table = 'orders'): SearchDocument {
	return {
		id: table,
		kind: 'table',
		resource: {
			type: 'integration',
			integration_id: entry.id,
			version: 1,
			namespace: ['sales'],
			table,
		},
		title: table,
		text: table,
		fingerprint: `1:${entry.updated_at}`,
	};
}
describe('integration search source', () => {
	it('publishes partial coverage instead of persisting an oversized Unicode namespace queue', async () => {
		const f = setup();
		const names = Array.from({ length: 25 }, (_, i) => `${i}${'界'.repeat(180)}`);
		f.integrations.browseNamespaces
			.mockResolvedValueOnce({ items: names.map((name) => [name]), next_cursor: null })
			.mockResolvedValueOnce({ items: names.map((name) => [names[0], name]), next_cursor: null });
		const bucket = new MemoryBucket();
		const index = new MemorySearchIndex();
		const services = createServices(bucket);
		vi.spyOn(services.projects, 'getProject').mockResolvedValue(f.project);
		const indexer = new SearchIndexer(
			bucket,
			index,
			[f.source],
			services.catalog,
			services.projects,
		);
		const scope = { projectId: f.project.id, source: f.source.id };
		expect(await indexer.step(f.project.id, f.source, signal)).toBe(false);
		expect(await indexer.step(f.project.id, f.source, signal)).toBe(true);
		const snapshot = (await index.read(scope)).snapshot!;
		expect(snapshot.partial).toBe(true);
		expect(snapshot.documents).toHaveLength(51);
		expect((await bucket.get(searchPaths.scope(scope).checkpoint))!.size).toBeLessThanOrEqual(
			MAX_SEARCH_CHECKPOINT_BYTES,
		);
		expect(await indexer.step(f.project.id, f.source, signal)).toBe(false);
	});
	it.each([
		{ kind: 'snowflake', schemas: true, surfaces: [] },
		{ kind: 'iceberg-rest', schemas: false, surfaces: ['tables'] },
	])(
		'links $kind datasources to Integrations when schemas=$schemas',
		async ({ kind, schemas, surfaces }) => {
			const f = setup();
			f.entry.kind = kind;
			f.integrations.listKinds = () => [{ kind, browse_surfaces: surfaces }];
			const source = new IntegrationSource(
				f.integrations as unknown as ProjectIntegrationsService,
				new AuthorizationService({}),
				schemas,
			);
			const page = await source.page(f.project, undefined, signal);
			expect(page.documents).toHaveLength(1);
			expect(page.documents[0].kind).toBe('datasource');
			expect(resourceHref(f.project.id, page.documents[0])).toBe(
				`/projects/${f.project.id}/integrations`,
			);
			expect(f.integrations.browseNamespaces).not.toHaveBeenCalled();
		},
	);

	it.each(['namespaces', 'tables'])(
		'reports truncation when a provider exceeds the %s page limit',
		async (kind) => {
			const f = setup();
			const items = Array.from({ length: 26 }, (_, i) => `item${i}`);
			if (kind === 'namespaces') {
				f.integrations.browseNamespaces.mockResolvedValue({
					items: items.map((name) => [name]),
					next_cursor: null,
				});
				const page = await f.source.page(f.project, undefined, signal);
				expect(page.partial).toBe(true);
				expect(page.documents.filter((d) => d.kind === 'namespace')).toHaveLength(25);
			} else {
				const first = await f.source.page(f.project, undefined, signal);
				f.integrations.browseNamespaces.mockResolvedValue({ items: [], next_cursor: null });
				const second = await f.source.page(f.project, first.cursor, signal);
				f.integrations.browseTables.mockResolvedValue({ items, next_cursor: null });
				const page = await f.source.page(f.project, second.cursor, signal);
				expect(page.partial).toBe(true);
				expect(page.documents.filter((d) => d.kind === 'table')).toHaveLength(25);
			}
		},
	);
	it('terminates a repeated provider cursor and reports incomplete coverage', async () => {
		const f = setup();
		f.integrations.browseNamespaces.mockResolvedValue({ items: [], next_cursor: 'stuck' });
		const first = await f.source.page(f.project, undefined, signal);
		expect(first.cursor).toBeDefined();
		const second = await f.source.page(f.project, first.cursor, signal);
		expect(second.cursor).toBeUndefined();
		expect(second.partial).toBe(true);
	});
	it('rejects schema checks beyond the probe budget without making an extra call', async () => {
		const f = setup();
		const documents = Array.from({ length: 33 }, (_, i) => tableDocument(f.entry, `table${i}`));
		await expect(
			f.source.validate(f.project, documents, principal, 'rank', signal),
		).rejects.toThrow('catalog budget exceeded');
		expect(f.integrations.browseTableSchema).toHaveBeenCalledTimes(32);
	});
	it('shares schema probes within a phase but rechecks the upstream provider before returning', async () => {
		const f = setup();
		const table = tableDocument(f.entry);
		const docs = [table, { ...table, id: 'duplicate' }];
		expect(await f.source.validate(f.project, docs, principal, 'rank', signal)).toEqual(docs);
		expect(f.integrations.browseTableSchema).toHaveBeenCalledTimes(1);
		f.integrations.browseTableSchema.mockRejectedValueOnce(new Error('access revoked'));
		await expect(f.source.validate(f.project, docs, principal, 'return', signal)).rejects.toThrow(
			'access revoked',
		);
		expect(f.integrations.browseTableSchema).toHaveBeenCalledTimes(2);
	});
	it('excludes renamed and shadowed integration heads without probing the catalog', async () => {
		const f = setup();
		const doc = tableDocument(f.entry);
		const original = f.entry.updated_at;
		f.entry.updated_at = '2026-11-03T00:00:00.000Z';
		expect(await f.source.validate(f.project, [doc], principal, 'rank', signal)).toEqual([]);
		f.entry.updated_at = original;
		f.integrations.list.mockResolvedValue([{ ...f.entry, shadowed: true }]);
		expect(await f.source.validate(f.project, [doc], principal, 'return', signal)).toEqual([]);
		expect(f.integrations.browseTableSchema).not.toHaveBeenCalled();
	});
	it('resumes bounded discovery and indexes only names/types, without credentials or rows', async () => {
		const f = setup();
		const docs: SearchDocument[] = [];
		let cursor: string | undefined;
		for (let i = 0; i < 10; i++) {
			const page = await f.source.page(f.project, cursor, signal);
			docs.push(...page.documents);
			cursor = page.cursor;
			if (!cursor) break;
		}
		expect(cursor).toBeUndefined();
		expect(new Set(docs.map((d) => d.kind))).toEqual(
			new Set(['datasource', 'namespace', 'table', 'column']),
		);
		expect(docs.find((d) => d.kind === 'column')?.text).toBe('revenue: DOUBLE');
		expect(f.integrations.browseTableSchema).toHaveBeenCalledTimes(1);
	});
	it('uses the caller’s upstream identity before ranking and returning schemas', async () => {
		const f = setup();
		const doc: SearchDocument = {
			id: 'column',
			kind: 'column',
			resource: {
				type: 'integration',
				integration_id: f.entry.id,
				version: 1,
				namespace: ['sales'],
				table: 'orders',
				column: 'revenue',
			},
			title: 'revenue',
			text: 'revenue: DOUBLE',
			fingerprint: `1:${f.entry.updated_at}`,
		};
		expect(await f.source.validate(f.project, [doc], principal, 'rank', signal)).toEqual([doc]);
		expect(f.integrations.browseTableSchema).toHaveBeenLastCalledWith(
			f.project.id,
			f.entry.id,
			['sales'],
			'orders',
			{ query_user: principal.email, signal },
		);
		f.integrations.browseTableSchema.mockResolvedValueOnce({ columns: [] });
		expect(await f.source.validate(f.project, [doc], principal, 'return', signal)).toEqual([]);
	});
	it('excludes disabled or replaced integrations without probing catalogs', async () => {
		const f = setup();
		const doc: SearchDocument = {
			id: 'data',
			kind: 'datasource',
			resource: { type: 'integration', integration_id: f.entry.id, version: 1 },
			title: 'Warehouse',
			text: 'Warehouse',
			fingerprint: `1:${f.entry.updated_at}`,
		};
		f.entry.enabled = false;
		expect(await f.source.validate(f.project, [doc], principal, 'rank', signal)).toEqual([]);
		f.entry.enabled = true;
		f.entry.current_version = 2;
		expect(await f.source.validate(f.project, [doc], principal, 'return', signal)).toEqual([]);
		expect(f.integrations.browseTableSchema).not.toHaveBeenCalled();
	});
	it('denies schema access to project viewers', async () => {
		const f = setup();
		const viewer = { ...principal, id: UserId.parse('viewer') };
		f.project.members.push({ user_id: viewer.id, role: 'viewer' });
		expect(await f.source.validate(f.project, [], viewer, 'rank', signal)).toEqual([]);
		expect(f.integrations.list).not.toHaveBeenCalled();
	});
	it('reports failed discovery and advances rather than blocking all later integrations', async () => {
		const f = setup();
		f.integrations.browseNamespaces.mockRejectedValueOnce(new Error('Credentials: do not expose'));
		const page = await f.source.page(f.project, undefined, signal);
		expect(page.partial).toBe(true);
		expect(page.documents.map((d) => d.kind)).toEqual(['datasource']);
		expect(JSON.stringify(page)).not.toContain('Credentials');
	});
});
