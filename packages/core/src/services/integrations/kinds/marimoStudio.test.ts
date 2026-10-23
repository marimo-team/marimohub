import { describe, expect, it } from 'vitest';
import { createProjectId, createSessionId, UserId } from '../../../ids';
import { MemoryBucket } from '../../../testing/MemoryBucket';
import { AesGcmSecretCodec } from '../../secrets/AesGcmSecretCodec';
import { OrgIntegrationsStore, ProjectIntegrationsStore } from '../ProjectIntegrationsStore';
import { defaultRegistry } from './index';
import { marimoStudio } from './marimoStudio';

const actor = UserId.parse('studio-test');
const pid = createProjectId();
const context = {
	workload: { kind: 'session' as const, id: createSessionId() },
	principal: { userId: actor, email: 'test@example.com' },
};

function integrationStores() {
	const options = {
		bucket: new MemoryBucket(),
		registry: defaultRegistry(),
		codec: new AesGcmSecretCodec({ kek: 'sFjp5R6eWYvc9SGtfeYEsQQlMKB8MfP4FdFAD7JAjsw=' }),
	};
	return {
		org: new OrgIntegrationsStore(options),
		project: new ProjectIntegrationsStore(options),
	};
}

describe('marimo Studio', () => {
	it('marks the title experimental without a config or capability flag', () => {
		const descriptor = defaultRegistry().describe('marimo_studio');
		expect(descriptor.title).toBe('marimo Studio (experimental)');
		expect(descriptor).not.toHaveProperty('experimental');
		expect(descriptor.json_schema).not.toHaveProperty('properties.experimental');
		expect(descriptor).toMatchObject({ supports_test: false, supports_browse: false });
	});
	it.each([
		[{}, 'marimo-studio[deno]==0.4.1'],
		[{ deno: false }, 'marimo-studio==0.4.1'],
		[{ deno: false, typst: true }, 'marimo-studio[typst]==0.4.1'],
		[{ typst: true, version: '0.4.2' }, 'marimo-studio[deno,typst]==0.4.2'],
	])('renders a runtime dependency without workspace changes: %j', (config, requirement) => {
		expect(
			marimoStudio.render({
				...context,
				projectId: pid,
				instanceName: 'studio',
				config: marimoStudio.configSchema.parse(config),
			}),
		).toEqual({ runtimePackages: [requirement], workspaceLoadMode: 'copy-only' });
	});
	it.each(['latest', '>=0.4.1', '0.4.1 --index-url https://example.com', '0.4.1\n'])(
		'rejects an unpinned version %s',
		(version) => {
			expect(marimoStudio.configSchema.safeParse({ version }).success).toBe(false);
		},
	);
	it.each([
		{ experimental: true },
		{ version: null },
		{ version: `${'1'.repeat(32)}.0.0` },
		{ deno: 'false' },
		{ typst: 1 },
	])('rejects invalid configuration instead of silently applying defaults: %j', (config) => {
		expect(marimoStudio.configSchema.safeParse(config).success).toBe(false);
	});
	it('rejects conflicting org and project versions, then recovers when the conflicting integration is disabled', async () => {
		const { org, project } = integrationStores();
		await org.create({ kind: 'marimo_studio', name: 'org-studio', config: {} }, actor);
		const local = await project.create(
			pid,
			{ kind: 'marimo_studio', name: 'local-studio', config: { version: '0.4.2' } },
			actor,
		);
		await expect(project.resolveForSession(pid, context)).rejects.toThrow(
			'different versions of runtime package "marimo-studio"',
		);
		await project.update(pid, local.id, { enabled: false }, actor);
		expect((await project.resolveForSession(pid, context))?.runtimePackages).toEqual([
			'marimo-studio[deno]==0.4.1',
		]);
	});
	it('inherits org packages, supports project opt-out, and stops rendering disabled or deleted integrations', async () => {
		const { org, project } = integrationStores();
		await org.create({ kind: 'marimo_studio', name: 'studio', config: {} }, actor);
		expect((await project.resolveForSession(pid, context))?.workspaceLoadMode).toBe('copy-only');
		expect((await project.resolveForSession(pid, context))?.runtimePackages).toEqual([
			'marimo-studio[deno]==0.4.1',
		]);
		const local = await project.create(
			pid,
			{ kind: 'marimo_studio', name: 'studio', config: { deno: false } },
			actor,
		);
		expect((await project.resolveForSession(pid, context))?.runtimePackages).toEqual([
			'marimo-studio==0.4.1',
		]);
		await project.update(pid, local.id, { enabled: false }, actor);
		expect((await project.resolveForSession(pid, context))?.runtimePackages).toBeUndefined();
		expect((await project.resolveForSession(pid, context))?.workspaceLoadMode).toBeUndefined();
		await project.delete(pid, local.id);
		expect((await project.resolveForSession(pid, context))?.runtimePackages).toEqual([
			'marimo-studio[deno]==0.4.1',
		]);
	});
});
