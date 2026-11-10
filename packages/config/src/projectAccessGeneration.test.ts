import { describe, expect, it, vi } from 'vitest';
import { ACTOR, uid } from '@marimo-hub/core/testing';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { createFromEnv } from './index';

describe('project access generation configuration', () => {
	it.each([
		[undefined, undefined],
		['', undefined],
		[' \t ', undefined],
		[' Rollout-A ', 'Rollout-A'],
	])('uses metadata unless a generation is configured (%j)', async (value, generation) => {
		const bucket = new MemoryBucket();
		const { services } = createFromEnv(
			{
				MARIMOHUB_STORAGE_BACKEND: 'library',
				MARIMOHUB_COMPUTE_BACKEND: 'none',
				MARIMOHUB_AUTH_BACKEND: 'dev',
				MARIMOHUB_PROJECT_ACCESS_GENERATION: value,
			},
			undefined,
			{ libraries: { bucket } },
		);
		await services.catalog.initialize(ACTOR);
		const project = await services.projects.createProject(
			{ name: 'Shared', description: '' },
			ACTOR,
		);
		const subject = { id: uid('member'), email: 'member@example.com' };
		await services.projects.addMember(project.id, { user_id: subject.id }, 'viewer', ACTOR);
		const [entry] = (await services.catalog.getCurrentSnapshot()).projects;
		expect(entry.access?.generation).toBe(generation);

		const get = vi.spyOn(bucket, 'get');
		expect((await services.projects.listProjects({ subject })).map((entry) => entry.id)).toEqual([
			project.id,
		]);
		expect(get.mock.calls.filter(([key]) => key.endsWith('/project.json'))).toHaveLength(
			generation ? 0 : 1,
		);
	});
});
