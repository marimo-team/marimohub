import { describe, expect, it, vi } from 'vitest';
import type { DataQueryExecution, PostgresConnectionCapability } from '@marimo-hub/core';
import { createPostgresDataQueryExecutorFactory, PostgresDatabaseBrowser } from './node';

const source: PostgresConnectionCapability = {
	provider: 'postgres',
	host: 'database.example.test',
	port: 5432,
	database: 'app',
	username: 'reader',
	password: 'secret-value',
	tls: { mode: 'verify-full', ca: { kind: 'system' } },
};

function browser(resolveHost = vi.fn(async () => [{ address: '203.0.113.10', family: 4 }])) {
	return {
		resolveHost,
		browser: new PostgresDatabaseBrowser({
			resolveHost,
			mode: 'metadata',
			metadataTimeoutMs: 100,
			previewTimeoutMs: 100,
			previewMaxBytes: 1024,
		}),
	};
}

describe('PostgresDatabaseBrowser', () => {
	it('returns an empty page for child namespaces without resolving the target', async () => {
		const runtime = browser();

		await expect(
			runtime.browser.listNamespaces(source, { limit: 10, parent: ['public'] }),
		).resolves.toEqual({ items: [], next_cursor: null });
		expect(runtime.resolveHost).not.toHaveBeenCalled();
	});

	it('includes DNS resolution in the metadata deadline', async () => {
		let resolverSignal: AbortSignal | undefined;
		const resolveHost = vi.fn(async (_host: string, signal?: AbortSignal) => {
			resolverSignal = signal;
			return new Promise<never>(() => {});
		});
		const runtime = new PostgresDatabaseBrowser({
			resolveHost,
			mode: 'metadata',
			metadataTimeoutMs: 10,
			previewTimeoutMs: 100,
			previewMaxBytes: 1024,
		});

		await expect(runtime.listNamespaces(source, { limit: 10 })).rejects.toMatchObject({
			message: 'The PostgreSQL request timed out.',
		});
		expect(resolverSignal?.aborted).toBe(true);
	});

	it('cancels DNS resolution with the caller signal', async () => {
		let resolverSignal: AbortSignal | undefined;
		const resolveHost = vi.fn(async (_host: string, signal?: AbortSignal) => {
			resolverSignal = signal;
			return new Promise<never>(() => {});
		});
		const runtime = new PostgresDatabaseBrowser({
			resolveHost,
			mode: 'metadata',
			metadataTimeoutMs: 1_000,
			previewTimeoutMs: 1_000,
			previewMaxBytes: 1024,
		});
		const controller = new AbortController();
		const pending = runtime.listNamespaces(source, { limit: 10, signal: controller.signal });
		controller.abort();

		await expect(pending).rejects.toMatchObject({
			name: 'AbortError',
			message: 'The PostgreSQL request was cancelled.',
		});
		expect(resolverSignal?.aborted).toBe(true);
	});

	it('rejects direct mutation before DNS resolution', async () => {
		const resolveHost = vi.fn(async () => [{ address: '203.0.113.10', family: 4 }]);
		const factory = createPostgresDataQueryExecutorFactory({ resolveHost });
		const executor = await factory.create(new AbortController().signal);
		const request: DataQueryExecution = {
			sql: 'UPDATE things SET id = 2',
			connection: {
				files: [],
				vars: {},
				integration: { id: 'test' as never, name: 'test', kind: 'postgres', version: 1 },
				plan: { engine: 'postgres', connection: source },
			},
			accessMode: 'read-only',
			limits: { maxRows: 10, maxBytes: 1024, deadlineMs: 100 },
		};

		await expect(executor.execute(request, new AbortController().signal)).rejects.toThrow(
			'accepts only SELECT or WITH',
		);
		expect(resolveHost).not.toHaveBeenCalled();
	});

	it('includes DNS resolution in the query deadline', async () => {
		let resolverSignal: AbortSignal | undefined;
		const resolveHost = vi.fn(async (_host: string, signal?: AbortSignal) => {
			resolverSignal = signal;
			return new Promise<never>(() => {});
		});
		const factory = createPostgresDataQueryExecutorFactory({ resolveHost });
		const executor = await factory.create(new AbortController().signal);
		const request: DataQueryExecution = {
			sql: 'SELECT 1',
			connection: {
				files: [],
				vars: {},
				integration: { id: 'test' as never, name: 'test', kind: 'postgres', version: 1 },
				plan: { engine: 'postgres', connection: source },
			},
			accessMode: 'read-only',
			limits: { maxRows: 10, maxBytes: 1024, deadlineMs: 10 },
		};

		await expect(executor.execute(request, new AbortController().signal)).rejects.toThrow(
			'The PostgreSQL request timed out.',
		);
		expect(resolverSignal?.aborted).toBe(true);
	});

	it.each(['bad', 'name:', 'name:%E0%A4%A'])(
		'rejects malformed cursors before resolving',
		async (cursor) => {
			const runtime = browser();

			await expect(
				runtime.browser.listTables(source, ['public'], { limit: 10, cursor }),
			).rejects.toThrow('Invalid browse cursor');
			expect(runtime.resolveHost).not.toHaveBeenCalled();
		},
	);

	it('rejects zero or nested relation namespaces before resolving', async () => {
		const runtime = browser();

		await expect(runtime.browser.listTables(source, [], { limit: 10 })).rejects.toThrow(
			'one schema namespace',
		);
		await expect(runtime.browser.listTables(source, ['one', 'two'], { limit: 10 })).rejects.toThrow(
			'one schema namespace',
		);
		expect(runtime.resolveHost).not.toHaveBeenCalled();
	});

	it('does not expose resolver diagnostics or connection details', async () => {
		const runtime = browser(
			vi.fn(async () => {
				throw new Error('blocked database.example.test secret-value');
			}),
		);

		await expect(runtime.browser.listNamespaces(source, { limit: 10 })).rejects.toMatchObject({
			message: 'The PostgreSQL target is not permitted.',
		});
	});

	it.each([
		{ addresses: [] },
		{ addresses: [{ address: 'database.example.test', family: 4 }] },
		{ addresses: [{ address: '203.0.113.10', family: 6 }] },
		{ addresses: [{ address: '2001:db8::10', family: 4 }] },
	])('rejects invalid pinned resolver output', async ({ addresses }) => {
		const runtime = browser(vi.fn(async () => addresses));

		await expect(runtime.browser.listNamespaces(source, { limit: 10 })).rejects.toMatchObject({
			message: 'The PostgreSQL target is not permitted.',
		});
	});

	it('disables previews in metadata mode before resolving', async () => {
		const runtime = browser();

		expect(() => runtime.browser.previewRows(source, ['public'], 'orders', { limit: 10 })).toThrow(
			'full data-browser mode',
		);
		expect(runtime.resolveHost).not.toHaveBeenCalled();
	});
});
