import { describe, it, expect } from 'vitest';
import { createProjectId } from '@marimo-hub/core';
import { createTestApi } from './testing';

describe('request id correlation', () => {
	it('echoes an inbound X-Request-Id into the header and error envelope', async () => {
		const { app } = createTestApi();
		const res = await app.request(`/api/v1/projects/${createProjectId()}`, {
			headers: { 'X-Request-Id': 'test-req-123' },
		});
		expect(res.status).toBe(404);
		expect(res.headers.get('x-request-id')).toBe('test-req-123');
		const body = (await res.json()) as { error: { request_id?: string } };
		expect(body.error.request_id).toBe('test-req-123');
	});

	it('mints a request id when none is provided and reflects it in both places', async () => {
		const { app } = createTestApi();
		const res = await app.request(`/api/v1/projects/${createProjectId()}`);
		expect(res.status).toBe(404);
		const id = res.headers.get('x-request-id');
		expect(id).toBeTruthy();
		const body = (await res.json()) as { error: { request_id?: string } };
		expect(body.error.request_id).toBe(id);
	});
});
