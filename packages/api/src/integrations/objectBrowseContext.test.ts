import { afterEach, describe, expect, it, vi } from 'vitest';
import { Millis, UserId } from '@marimo-hub/core';
import type { Project, TempS3Creds } from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { makeTestWif } from '../testing';
import { clearObjectCredentialCacheForTests, makeObjectBrowseContext } from './objectBrowseContext';

const project = {
	id: 'proj-01J00000000000000000000000',
	federation: { enabled: true },
} as Project;
const user = { id: UserId.parse('user-object-context'), email: 'object@example.com' };

afterEach(() => {
	vi.restoreAllMocks();
	clearObjectCredentialCacheForTests();
});

describe('makeObjectBrowseContext', () => {
	it('logs a failed credential exchange once without its message', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const exchange = vi.fn<() => Promise<TempS3Creds>>(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			throw Object.assign(new Error('sts said secret-detail'), { code: 'AccessDenied' });
		});
		const deps = {
			wif: makeTestWif({ exchange }),
			dataBrowser: {
				preview: true,
				objectBrowser: {
					allowServerAmbientCredentials: false,
					maxConcurrentDownloads: 1,
					maxConcurrentDownloadsPerUser: 1,
					downloadTimeoutMs: Millis.of(60_000),
				},
			},
		} as unknown as ApiDeps;

		const contexts = await Promise.all([
			makeObjectBrowseContext(deps, project, user, undefined, { integrationId: 'a' }),
			makeObjectBrowseContext(deps, project, user, undefined, { integrationId: 'a' }),
		]);

		expect(contexts.map((context) => context.federation)).toEqual([undefined, undefined]);
		expect(exchange).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledOnce();
		const line = log.mock.calls[0]?.[0] as string;
		expect(JSON.parse(line)).toMatchObject({
			level: 'warn',
			event: 'object_browse_wif_exchange_failed',
			project_id: project.id,
			integration_id: 'a',
			error_name: 'Error',
			error_code: 'AccessDenied',
		});
		expect(line).not.toContain('secret-detail');
	});
});
