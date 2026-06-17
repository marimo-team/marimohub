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
