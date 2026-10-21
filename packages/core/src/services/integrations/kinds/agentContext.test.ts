import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../../errors';
import { createProjectId, createSessionId, UserId } from '../../../ids';
import { MemoryBucket } from '../../../testing/MemoryBucket';
import { AesGcmSecretCodec } from '../../secrets/AesGcmSecretCodec';
import { OrgIntegrationsStore, ProjectIntegrationsStore } from '../ProjectIntegrationsStore';
import { AGENT_CONTEXT_DIR } from '../agentContext';
import { agentContext, agentContextConfig } from './agentContext';
import { defaultRegistry } from './index';

const TEST_KEK = 'sFjp5R6eWYvc9SGtfeYEsQQlMKB8MfP4FdFAD7JAjsw=';
const actor = UserId.parse('agent-test');
const context = {
	workload: { kind: 'session' as const, id: createSessionId() },
	principal: { userId: actor, email: 'test@example.com' },
};
function stores() {
	const options = {
		bucket: new MemoryBucket(),
		registry: defaultRegistry(),
		codec: new AesGcmSecretCodec({ kek: TEST_KEK }),
	};
	return {
		org: new OrgIntegrationsStore(options),
		project: new ProjectIntegrationsStore(options),
		pid: createProjectId(),
	};
}

describe('agent context validation', () => {
	it.each([
		{ instructions: 'x'.repeat(32769) },
		{ instructions: 'é'.repeat(16385) },
		{ skills: [{ name: 'ok', content: 'x'.repeat(65537) }] },
		{ skills: [{ name: 'ok', content: 'é'.repeat(32769) }] },
		{ skills: Array.from({ length: 17 }, (_, i) => ({ name: `skill-${i}`, content: '' })) },
		{ opencode_json: JSON.stringify({ a: 'x'.repeat(16384) }) },
		{ claude_settings_json: JSON.stringify({ a: 'é'.repeat(8192) }) },
	])('enforces UTF-8 size and count limits', (config) => {
		expect(agentContextConfig.safeParse(config).success).toBe(false);
	});
	it.each([
		'../escape',
		'/absolute',
		'UPPER',
		'has space',
		'',
		'a'.repeat(65),
		'a/b',
		'name\n',
		'name\r',
		'name\u0000',
	])('rejects skill name %s', (name) => {
		expect(agentContextConfig.safeParse({ skills: [{ name, content: '' }] }).success).toBe(false);
	});
	it.each(['[]', 'null', 'true', '"string"', '{invalid'])(
		'rejects non-object settings %s',
		(value) => {
			expect(agentContextConfig.safeParse({ opencode_json: value }).success).toBe(false);
			expect(agentContextConfig.safeParse({ claude_settings_json: value }).success).toBe(false);
		},
	);
	it('accepts exact text limits and empty optional configuration', () => {
		expect(
			agentContextConfig.safeParse({
				instructions: 'é'.repeat(16384),
				skills: [{ name: 'a'.repeat(64), content: 'x'.repeat(65536) }],
			}).success,
		).toBe(true);
		expect(agentContextConfig.parse({})).toEqual({});
	});
	it('rejects the baked skill and duplicate names on save', async () => {
		const { org } = stores();
		for (const skills of [
			[{ name: 'marimo-pair', content: '' }],
			[
				{ name: 'same', content: '' },
				{ name: 'same', content: '' },
			],
		]) {
			await expect(
				org.create({ kind: 'agent_context', name: 'team', config: { skills } }, actor),
			).rejects.toThrow(ValidationError);
		}
	});
	it('publishes UTF-8 byte limits in the client schema', () => {
		const { json_schema } = defaultRegistry().describe(agentContext.kind);
		expect(json_schema).toMatchObject({
			properties: {
				instructions: {
					'x-max-utf8-bytes': 32768,
					description: expect.stringContaining('32768 UTF-8 bytes'),
				},
				skills: {
					items: {
						properties: {
							content: {
								'x-max-utf8-bytes': 65536,
								description: expect.stringContaining('65536 UTF-8 bytes'),
							},
						},
					},
				},
				opencode_json: {
					'x-max-utf8-bytes': 16384,
					description: expect.stringContaining('16384 UTF-8 bytes'),
				},
				claude_settings_json: {
					'x-max-utf8-bytes': 16384,
					description: expect.stringContaining('16384 UTF-8 bytes'),
				},
			},
		});
	});
	it('publishes a non-browsable kind with multiline fields', () => {
		const descriptor = defaultRegistry().describe(agentContext.kind);
		expect(descriptor.supports_browse).toBe(false);
		expect(descriptor.supports_test).toBe(false);
		expect(descriptor.ui_hints['skills.*.content'].widget).toBe('textarea');
	});
});

describe('agent context tiers', () => {
	it('appends project instructions and retains org MCP servers and plugin lists', async () => {
		const { org, project, pid } = stores();
		await org.create(
			{
				kind: 'agent_context',
				name: 'aaa-org',
				config: {
					instructions: 'Use polars.',
					skills: [{ name: 'team', content: '# Team' }],
					opencode_json: JSON.stringify({
						plugin: ['org-plugin'],
						mcp: { shared: { type: 'remote', url: 'https://org.example' } },
					}),
					claude_settings_json: JSON.stringify({ permissions: { deny: ['Bash(rm *)'] } }),
				},
			},
			actor,
		);
		await project.create(
			pid,
			{
				kind: 'agent_context',
				name: 'zzz-project',
				config: {
					instructions: 'Use the analytics catalog.',
					skills: [{ name: 'project', content: '# Project' }],
					opencode_json: JSON.stringify({
						plugin: ['project-plugin'],
						mcp: {
							shared: { command: ['evil'] },
							extra: { type: 'remote', url: 'https://extra.example' },
						},
					}),
					claude_settings_json: JSON.stringify({ permissions: { deny: [], allow: ['Read'] } }),
				},
			},
			actor,
		);
		const result = await project.resolveForSession(pid, context);
		expect(result?.files).toContainEqual({
			path: '.claude/CLAUDE.md',
			relativeTo: 'home',
			content: 'Use polars.\n\n## Project\n\nUse the analytics catalog.',
		});
		expect(result?.vars.MARIMOHUB_AGENT_CONTEXT_DIR).toBe(AGENT_CONTEXT_DIR);
		const settings = JSON.parse(
			result!.files.find((f) => f.path === `${AGENT_CONTEXT_DIR}/opencode.json`)!.content,
		);
		expect(settings).toEqual({
			plugin: ['org-plugin'],
			mcp: {
				shared: { type: 'remote', url: 'https://org.example' },
				extra: { type: 'remote', url: 'https://extra.example' },
			},
		});
		expect(result?.files.filter((f) => f.path.endsWith('/SKILL.md'))).toHaveLength(4);
		expect(
			JSON.parse(result!.files.find((f) => f.path === '.claude/settings.json')!.content),
		).toEqual({ permissions: { deny: ['Bash(rm *)'], allow: ['Read'] } });
	});
	it('rejects skill collisions across org and project integrations', async () => {
		const { org, project, pid } = stores();
		const config = { skills: [{ name: 'shared', content: 'skill' }] };
		await org.create({ kind: 'agent_context', name: 'org', config }, actor);
		await project.create(pid, { kind: 'agent_context', name: 'project', config }, actor);
		await expect(project.resolveForSession(pid, context)).rejects.toThrow(/Duplicate agent skill/);
	});
	it('preserves whole-integration shadowing, including disabled project opt-outs', async () => {
		const { org, project, pid } = stores();
		await org.create(
			{ kind: 'agent_context', name: 'team', config: { instructions: 'org' } },
			actor,
		);
		const local = await project.create(
			pid,
			{ kind: 'agent_context', name: 'team', config: { instructions: 'project' } },
			actor,
		);
		const result = await project.resolveForSession(pid, context);
		expect(result?.files.find((f) => f.path === '.claude/CLAUDE.md')?.content).toBe('project');
		await project.update(pid, local.id, { enabled: false }, actor);
		expect(await project.resolveForSession(pid, context)).toBeUndefined();
	});
});

it('accepts exact JSON byte limits and rejects the next byte', () => {
	const content = JSON.stringify({ value: '' });
	const remaining = 16 * 1024 - new TextEncoder().encode(content).byteLength;
	for (const key of ['opencode_json', 'claude_settings_json']) {
		expect(
			agentContextConfig.safeParse({ [key]: JSON.stringify({ value: 'x'.repeat(remaining) }) })
				.success,
		).toBe(true);
		expect(
			agentContextConfig.safeParse({ [key]: JSON.stringify({ value: 'x'.repeat(remaining + 1) }) })
				.success,
		).toBe(false);
	}
});

it('does not compose skills from disabled org integrations', async () => {
	const { org, project, pid } = stores();
	const config = { skills: [{ name: 'same', content: 'project' }] };
	const shared = await org.create({ kind: 'agent_context', name: 'org', config }, actor);
	await org.update(shared.id, { enabled: false }, actor);
	await project.create(pid, { kind: 'agent_context', name: 'project', config }, actor);
	const result = await project.resolveForSession(pid, context);
	expect(result?.files.filter((file) => file.path.endsWith('/SKILL.md'))).toHaveLength(2);
});

it('leaves the previous version intact after an invalid update', async () => {
	const { org } = stores();
	const shared = await org.create(
		{ kind: 'agent_context', name: 'org', config: { instructions: 'valid' } },
		actor,
	);
	await expect(org.update(shared.id, { config: { opencode_json: 'null' } }, actor)).rejects.toThrow(
		ValidationError,
	);
	await expect(org.get(shared.id)).resolves.toMatchObject({
		current_version: 1,
		config: { instructions: 'valid' },
	});
});
