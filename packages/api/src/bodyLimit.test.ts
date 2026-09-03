import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_BYTES } from '@marimo-hub/core';
import { createTestApi, expectError, expectOk } from './testing';

describe('request body limit', () => {
	it('rejects a body past MAX_REQUEST_BYTES with a 413 envelope before any handler runs', async () => {
		const { request } = createTestApi();
		// A JSON payload comfortably over the cap.
		const huge = { name: 'x'.repeat(MAX_REQUEST_BYTES + 1024) };

		const res = await request('POST', '/projects', huge);

		await expectError(res, 413, 'PAYLOAD_TOO_LARGE');
	});

	it('rejects an oversized /api/sync/* push with a 413 envelope', async () => {
		const { app } = createTestApi();
		// A body comfortably over the cap pushed at the git-sync endpoint (its own
		// bodyLimit, separate from the /api/v1 one).
		const huge = new Uint8Array(MAX_REQUEST_BYTES + 1024);
		const res = await app.request(
			'/api/sync/git/v1/projects/proj-0000000000000000/notebooks/nb-0000000000000000',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/zip' },
				body: huge,
			},
		);
		await expectError(res, 413, 'PAYLOAD_TOO_LARGE');
	});

	it.each(['/register', '/token', '/revoke', '/mcp'])(
		'rejects an oversized MCP request at %s',
		async (path) => {
			const { app } = createTestApi({
				deps: { mcp: { publicBaseUrl: 'https://hub.example.com' } },
			});
			const res = await app.request(path, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': String(MAX_REQUEST_BYTES + 1),
				},
				body: '{}',
			});

			await expectError(res, 413, 'PAYLOAD_TOO_LARGE');
		},
	);

	it.each(['/register', '/token', '/revoke', '/mcp'])(
		'leaves the disabled MCP route at %s unclaimed',
		async (path) => {
			const { app } = createTestApi();
			const res = await app.request(path, {
				method: 'POST',
				headers: { 'Content-Length': String(MAX_REQUEST_BYTES + 1) },
				body: '{}',
			});

			expect(res.status).toBe(404);
		},
	);

	it('lets a normal-sized body through', async () => {
		const { request } = createTestApi();

		const res = await request('POST', '/projects', {
			name: 'ML Pipeline',
			description: 'ML notebooks',
		});

		const data = await expectOk<{ name: string }>(res, 201);
		expect(data.name).toBe('ML Pipeline');
	});
});
