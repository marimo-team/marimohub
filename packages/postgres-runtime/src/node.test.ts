import { describe, expect, it, vi } from 'vitest';
import type { PostgresConnectionCapability } from '@marimo-hub/core';
import { PostgresDatabaseBrowser } from './node';

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
		const resolveHost = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 15));
			return [{ address: '203.0.113.10', family: 4 }];
		});
		const runtime = new PostgresDatabaseBrowser({
			resolveHost,
			mode: 'metadata',
			metadataTimeoutMs: 5,
			previewTimeoutMs: 100,
			previewMaxBytes: 1024,
		});

		await expect(runtime.listNamespaces(source, { limit: 10 })).rejects.toMatchObject({
			message: 'The PostgreSQL request timed out.',
		});
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
