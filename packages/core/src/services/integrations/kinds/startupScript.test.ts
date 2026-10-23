import { describe, expect, it } from 'vitest';
import { createProjectId, createRunId, createSessionId, UserId } from '../../../ids';
import { MemoryBucket } from '../../../testing/MemoryBucket';
import { OrgIntegrationsStore, ProjectIntegrationsStore } from '../ProjectIntegrationsStore';
import { defaultRegistry } from './index';
import { startupScript } from './startupScript';

const actor = UserId.parse('startup-test');
const pid = createProjectId();
const context = {
	workload: { kind: 'session' as const, id: createSessionId() },
	principal: { userId: actor, email: 'test@example.com' },
};

describe('startup script', () => {
	it.each(['', ' \n', 'echo\0bad', 'x'.repeat(65537), 'é'.repeat(32769)])(
		'rejects empty, binary, or oversized script content %#',
		(script) => expect(startupScript.configSchema.safeParse({ script }).success).toBe(false),
	);

	it.each([
		{},
		{ script: null },
		{ script: 42 },
		{ script: ['echo ready'] },
		{ script: 'echo ready', unexpected: true },
	])('rejects malformed authoring configuration %j', (config) => {
		expect(startupScript.configSchema.safeParse(config).success).toBe(false);
	});

	it.each(['x'.repeat(65536), 'é'.repeat(32768), '🙂'.repeat(16384)])(
		'accepts exactly 64 KiB of UTF-8 text %#',
		(script) => {
			expect(startupScript.configSchema.parse({ script })).toEqual({ script });
			expect(startupScript.configSchema.safeParse({ script: `${script}x` }).success).toBe(false);
		},
	);

	it('keeps the previous version executable after an invalid update', async () => {
		const project = new ProjectIntegrationsStore({
			bucket: new MemoryBucket(),
			registry: defaultRegistry(),
		});
		const original = await project.create(
			pid,
			{
				kind: 'startup_script',
				name: 'bootstrap',
				config: { script: 'echo valid' },
			},
			actor,
		);
		await expect(
			project.update(pid, original.id, { config: { script: 'echo\0bad' } }, actor),
		).rejects.toThrow();
		const current = await project.get(pid, original.id);
		expect(current).toMatchObject({ current_version: 1, config: { script: 'echo valid' } });
		const rendered = await project.resolveForSession(pid, context);
		expect(rendered?.attachments).toEqual([
			expect.objectContaining({ id: original.id, version: 1 }),
		]);
		expect(rendered?.files).toContainEqual({
			path: '/tmp/marimohub-integrations/startup/bootstrap.sh',
			content: 'echo valid',
		});
	});

	it('normalizes Windows newlines and keeps scripts outside the workspace', () => {
		expect(
			startupScript.render({
				...context,
				projectId: pid,
				instanceName: 'bootstrap',
				config: { script: '#!/bin/sh\r\necho ready\r\n' },
			}),
		).toEqual({
			workspaceLoadMode: 'copy-only',
			files: [{ path: 'startup/bootstrap.sh', content: '#!/bin/sh\necho ready\n' }],
			startupScripts: ['startup/bootstrap.sh'],
		});
	});

	it('applies current versions and project overrides to sessions and jobs', async () => {
		const options = { bucket: new MemoryBucket(), registry: defaultRegistry() };
		const org = new OrgIntegrationsStore(options);
		const project = new ProjectIntegrationsStore(options);
		await org.create(
			{ kind: 'startup_script', name: 'bootstrap', config: { script: 'echo org' } },
			actor,
		);
		const local = await project.create(
			pid,
			{
				kind: 'startup_script',
				name: 'bootstrap',
				config: { script: 'echo project' },
			},
			actor,
		);
		const script = (render: Awaited<ReturnType<typeof project.resolveForSession>>) =>
			render?.files.find((file) => file.path.endsWith('/startup/bootstrap.sh'))?.content;
		expect(script(await project.resolveForSession(pid, context))).toBe('echo project');
		await project.update(pid, local.id, { config: { script: 'echo updated' } }, actor);
		const job = await project.resolveForSession(pid, {
			...context,
			workload: { kind: 'job-run', id: createRunId() },
		});
		expect(script(job)).toBe('echo updated');
		expect(job?.attachments).toEqual([expect.objectContaining({ id: local.id, version: 2 })]);
		expect(job?.startupScripts).toEqual(['/tmp/marimohub-integrations/startup/bootstrap.sh']);
		await project.update(pid, local.id, { enabled: false }, actor);
		expect((await project.resolveForSession(pid, context))?.startupScripts).toBeUndefined();
		await project.delete(pid, local.id);
		expect(script(await project.resolveForSession(pid, context))).toBe('echo org');
	});
});
