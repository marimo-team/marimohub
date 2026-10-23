import { describe, expect, it } from 'vitest';
import { createProjectId, createSessionId, UserId } from '../../../ids';
import { MemoryBucket } from '../../../testing/MemoryBucket';
import { OrgIntegrationsStore, ProjectIntegrationsStore } from '../ProjectIntegrationsStore';
import { defaultRegistry } from './index';
import { customCss, htmlHead } from './presentation';

const actor = UserId.parse('presentation-test');
const pid = createProjectId();
const context = {
	workload: { kind: 'session' as const, id: createSessionId() },
	principal: { userId: actor, email: 'test@example.com' },
};

describe.each([
	{ definition: customCss, field: 'css', valid: 'body { color: red; }' },
	{ definition: htmlHead, field: 'html', valid: '<meta name="author" content="Team">' },
])('$definition.kind', ({ definition, field, valid }) => {
	it.each(['', ' \n', 'a\0b', 'x'.repeat(65537), 'é'.repeat(32769)])(
		'rejects blank, binary, and oversized input %#',
		(value) => {
			expect(definition.configSchema.safeParse({ [field]: value }).success).toBe(false);
		},
	);
	it.each([{}, { [field]: null }, { [field]: 42 }, { [field]: valid, extra: true }])(
		'rejects malformed configuration %j',
		(config) => {
			expect(definition.configSchema.safeParse(config).success).toBe(false);
		},
	);
	it('accepts exactly 64 KiB of UTF-8', () => {
		expect(definition.configSchema.safeParse({ [field]: '🙂'.repeat(16384) }).success).toBe(true);
	});
	it('inherits, overrides, updates, and removes presentation without changing notebook files', async () => {
		const options = { bucket: new MemoryBucket(), registry: defaultRegistry() };
		const org = new OrgIntegrationsStore(options);
		const project = new ProjectIntegrationsStore(options);
		const input = { kind: definition.kind, name: 'branding', config: { [field]: valid } };
		await org.create(input, actor);
		const local = await project.create(pid, input, actor);
		const initial = await project.resolveForSession(pid, context);
		expect(initial?.attachments).toEqual([expect.objectContaining({ id: local.id, version: 1 })]);
		expect(initial?.files.some((file) => file.content === valid)).toBe(true);
		expect(
			initial?.files.every((file) => file.path.startsWith('/tmp/marimohub-integrations/')),
		).toBe(true);
		await expect(
			project.update(pid, local.id, { config: { [field]: '\0' } }, actor),
		).rejects.toThrow();
		expect(await project.get(pid, local.id)).toMatchObject({
			current_version: 1,
			config: { [field]: valid },
		});
		expect((await project.resolveForSession(pid, context))?.attachments).toEqual(
			initial?.attachments,
		);
		await project.update(pid, local.id, { config: { [field]: `${valid}\n` } }, actor);
		expect((await project.resolveForSession(pid, context))?.attachments).toEqual([
			expect.objectContaining({ id: local.id, version: 2 }),
		]);
		await project.update(pid, local.id, { enabled: false }, actor);
		const disabled = await project.resolveForSession(pid, context);
		expect(disabled?.marimoPresentation).toBeUndefined();
		await project.delete(pid, local.id);
		expect(
			(await project.resolveForSession(pid, context))?.files.some((file) => file.content === valid),
		).toBe(true);
	});
});
