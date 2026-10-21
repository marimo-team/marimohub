import { ValidationError } from '../../errors';
import { isRecord } from '../../internal/validation';
import type { SessionRender } from '../../ports/integrations';
import type { RenderedIntegration } from './bundle';
import { agentContextConfig, parseAgentJson, validateAgentSkills } from './kinds/agentContext';

export const AGENT_CONTEXT_DIR = '/tmp/marimohub-integrations/agent-context';
export const AGENT_HOME_FILES_MANIFEST = `${AGENT_CONTEXT_DIR}/home-files.json`;
export { AGENT_CONTEXT_DIR_ENV } from '../runtime/sandboxEnvironment';

export function assertAgentHomePath(path: string): void {
	if (path === '.claude/CLAUDE.md' || path === '.claude/settings.json') return;
	const match = /^\.(?:agents|claude)\/skills\/([a-z0-9-]{1,64})\/SKILL\.md$/.exec(path);
	if (match && match[1] !== 'marimo-pair') return;
	throw new ValidationError('Agent context file is outside the allowed home paths.');
}

/** Higher-priority MCP servers are atomic: lower tiers cannot add commands or headers to them. */
export function mergeAgentSettings(
	lower: Record<string, unknown>,
	higher: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		[...new Set([...Object.keys(lower), ...Object.keys(higher)])].map((key) => {
			if (!Object.hasOwn(higher, key)) return [key, lower[key]];
			const low = lower[key];
			const high = higher[key];
			if (isRecord(low) && isRecord(high)) {
				return [key, key === 'mcp' ? { ...low, ...high } : mergeAgentSettings(low, high)];
			}
			return [key, high];
		}),
	);
}

export function composeAgentContext(rendered: RenderedIntegration[]): SessionRender['files'] {
	const items = rendered.filter((item) => item.output.agentContext !== undefined);
	if (items.length === 0) return [];
	const instructions = { org: [] as string[], project: [] as string[] };
	const files: SessionRender['files'] = [];
	const skills = new Set<string>();
	let opencode: Record<string, unknown> = {};
	let claude: Record<string, unknown> | undefined;
	// Project settings enter first; org settings have final precedence regardless of instance name.
	for (const item of items.sort(
		(a, b) => Number(a.scope === 'org') - Number(b.scope === 'org') || a.name.localeCompare(b.name),
	)) {
		if (item.kind !== 'agent_context')
			throw new ValidationError('Only agent_context can render agent context.');
		const config = agentContextConfig.parse(item.output.agentContext);
		validateAgentSkills(config, skills);
		if (config.instructions) instructions[item.scope ?? 'project'].push(config.instructions);
		for (const skill of config.skills ?? []) {
			for (const dir of ['.agents', '.claude'])
				files.push({
					path: `${dir}/skills/${skill.name}/SKILL.md`,
					content: skill.content,
					relativeTo: 'home',
				});
		}
		if (config.opencode_json)
			opencode = mergeAgentSettings(opencode, parseAgentJson(config.opencode_json));
		if (config.claude_settings_json)
			claude = mergeAgentSettings(claude ?? {}, parseAgentJson(config.claude_settings_json));
	}
	const org = instructions.org.join('\n\n');
	const project = instructions.project.join('\n\n');
	const content = org && project ? `${org}\n\n## Project\n\n${project}` : org || project;
	if (content) files.push({ path: '.claude/CLAUDE.md', content, relativeTo: 'home' });
	if (claude)
		files.push({
			path: '.claude/settings.json',
			content: JSON.stringify(claude, null, 2),
			relativeTo: 'home',
		});
	for (const file of files) assertAgentHomePath(file.path);
	files.push({ path: `${AGENT_CONTEXT_DIR}/AGENTS.md`, content });
	files.push({
		path: `${AGENT_CONTEXT_DIR}/opencode.json`,
		content: JSON.stringify(opencode, null, 2),
	});
	return files;
}
