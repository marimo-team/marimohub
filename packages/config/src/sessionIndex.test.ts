import { describe, expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, paths } from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createFromEnv } from './index';

const env = {
	MARIMOHUB_STORAGE_BACKEND: 'library',
	MARIMOHUB_COMPUTE_BACKEND: 'none',
	MARIMOHUB_AUTH_BACKEND: 'dev',
};

describe('session index configuration', () => {
	it.each([undefined, 'off', 'shadow', 'on'])(
		'wires %s mode with shadow as the default',
		async (mode) => {
			const bucket = new MemoryBucket();
			const { services } = createFromEnv({ ...env, MARIMOHUB_SESSION_INDEX: mode }, undefined, {
				libraries: { bucket },
			});
			await services.sessions.createSession({
				user_id: ACTOR,
				project_id: createProjectId(),
				notebook_id: createNotebookId(),
			});
			if (mode === 'off') expect(await bucket.get(paths.sessionIndexForUser(ACTOR))).toBeNull();
			else expect(await bucket.get(paths.sessionIndexForUser(ACTOR))).not.toBeNull();
			const list = vi.spyOn(bucket, 'list');
			expect(await services.sessions.countActiveForUser(ACTOR)).toBe(1);
			expect(
				list.mock.calls.filter(([options]) => options?.prefix === paths.sessionsPrefix),
			).toHaveLength(mode === 'on' ? 0 : 1);
		},
	);

	it('rejects an unknown mode', () => {
		expect(() =>
			createFromEnv({ ...env, MARIMOHUB_SESSION_INDEX: 'enabled' }, undefined, {
				libraries: { bucket: new MemoryBucket() },
			}),
		).toThrow('MARIMOHUB_SESSION_INDEX');
	});
});
