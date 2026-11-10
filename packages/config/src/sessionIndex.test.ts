import { expect, it, vi } from 'vitest';
import { createNotebookId, createProjectId, paths } from '@marimo-hub/core';
import { ACTOR } from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createFromEnv } from './index';

it('automatically switches from scans to the session index after migration', async () => {
	const bucket = new MemoryBucket();
	const { services } = createFromEnv(
		{
			MARIMOHUB_STORAGE_BACKEND: 'library',
			MARIMOHUB_COMPUTE_BACKEND: 'none',
			MARIMOHUB_AUTH_BACKEND: 'dev',
		},
		undefined,
		{ libraries: { bucket } },
	);
	await services.catalog.initialize(ACTOR);
	await services.sessions.createSession({
		user_id: ACTOR,
		project_id: createProjectId(),
		notebook_id: createNotebookId(),
	});
	const list = vi.spyOn(bucket, 'list');
	expect(await services.sessions.countActiveForUser(ACTOR)).toBe(1);
	expect(list).toHaveBeenCalledWith(expect.objectContaining({ prefix: paths.sessionsPrefix }));
	while (!(await services.migrations.tick())) {}
	list.mockClear();
	expect(await services.sessions.countActiveForUser(ACTOR)).toBe(1);
	expect(list).not.toHaveBeenCalled();
});
