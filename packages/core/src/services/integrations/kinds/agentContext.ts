import { z } from 'zod';
import { ValidationError } from '../../../errors';
import { isRecord } from '../../../internal/validation';
import { defineIntegration } from '../sdk';

function boundedText(bytes: number, description: string) {
	return z
		.string()
		.max(bytes)
		.refine((value) => new TextEncoder().encode(value).length <= bytes, {
			message: `Must be at most ${bytes} UTF-8 bytes`,
		})
		.meta({
			'x-max-utf8-bytes': bytes,
			description: `${description}. Maximum ${bytes} UTF-8 bytes.`,
		});
}

export function parseAgentJson(value: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ValidationError('Agent settings must contain a valid JSON object.');
	}
	if (!isRecord(parsed)) throw new ValidationError('Agent settings must contain a JSON object.');
	return parsed;
}

function jsonSettings(description: string) {
	return boundedText(16 * 1024, description).refine((value) => {
		try {
			parseAgentJson(value);
			return true;
		} catch {
			return false;
		}
	}, 'Must contain a valid JSON object');
}

export const agentContextConfig = z.strictObject({
	instructions: boundedText(32 * 1024, 'Shared Markdown instructions for coding agents').optional(),
	skills: z
		.array(
			z.strictObject({
				name: z.string().regex(/^[a-z0-9-]{1,64}$/),
				content: boundedText(64 * 1024, 'Complete SKILL.md, including YAML frontmatter'),
			}),
		)
		.max(16)
		.optional(),
	opencode_json: jsonSettings(
		'OpenCode JSON configuration; reference custom environment variables for tokens',
	).optional(),
	claude_settings_json: jsonSettings(
		'Claude Code user settings JSON; do not include secrets',
	).optional(),
});

export type AgentContextConfig = z.infer<typeof agentContextConfig>;

export function validateAgentSkills(config: AgentContextConfig, names = new Set<string>()): void {
	for (const skill of config.skills ?? []) {
		if (skill.name === 'marimo-pair')
			throw new ValidationError(
				'The marimo-pair skill is supplied by the sandbox image and cannot be replaced.',
			);
		if (names.has(skill.name)) throw new ValidationError(`Duplicate agent skill "${skill.name}".`);
		names.add(skill.name);
	}
}

export const agentContext = defineIntegration({
	kind: 'agent_context',
	title: 'Agent context',
	description: 'Share coding instructions, skills, and agent settings with every sandbox.',
	category: 'other',
	brand: { color: '#7C3AED' },
	schemaVersion: 1,
	configSchema: agentContextConfig,
	uiHints: {
		instructions: { order: 1, widget: 'textarea' },
		skills: { order: 2 },
		'skills.*.content': { widget: 'textarea' },
		opencode_json: { order: 3, widget: 'textarea' },
		claude_settings_json: { order: 4, widget: 'textarea' },
	},
	validate: validateAgentSkills,
	render({ config }) {
		validateAgentSkills(config);
		return { agentContext: config };
	},
});
