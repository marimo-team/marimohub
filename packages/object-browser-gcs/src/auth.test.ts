import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectId, UserId } from '@marimo-hub/core';
import type { GcsObjectStoreSource, ObjectBrowseContext } from '@marimo-hub/core';
import { GcsAuth } from './auth';

const google = vi.hoisted(() => ({
	constructor: vi.fn(),
	getAccessToken: vi.fn(async () => 'adc-token'),
	getProjectId: vi.fn(async () => 'adc-project'),
}));
const originalCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

vi.mock('google-auth-library', () => ({
	GoogleAuth: class {
		constructor(options: unknown) {
			google.constructor(options);
		}

		getAccessToken = google.getAccessToken;
		getProjectId = google.getProjectId;
	},
}));

const source: GcsObjectStoreSource = {
	provider: 'gcs',
	auth: { method: 'ambient' },
};
const context: ObjectBrowseContext = {
	project_id: createProjectId(),
	user_id: UserId.parse('adc-user'),
	user_email: 'adc@example.com',
	allow_server_ambient: { gcs: true },
};

afterEach(() => {
	if (originalCredentialsPath === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
	else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalCredentialsPath;
	google.constructor.mockClear();
	google.getAccessToken.mockClear();
	google.getProjectId.mockClear();
});

describe('GCS ambient authentication', () => {
	it('delegates credential-file ADC types to the standard Google auth flow', async () => {
		process.env.GOOGLE_APPLICATION_CREDENTIALS = '/operator/adc.json';
		const auth = new GcsAuth(source, context, fetch);
		await expect(auth.headers()).resolves.toEqual({ Authorization: 'Bearer adc-token' });
		await expect(auth.projectId()).resolves.toBe('adc-project');
		expect(google.constructor).toHaveBeenCalledWith({
			scopes: 'https://www.googleapis.com/auth/devstorage.read_only',
		});
	});
});
