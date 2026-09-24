import { parseProjectResourceRules } from '@marimo-hub/core/project-resource-policy';
import type { ProjectResourceRule } from '@marimo-hub/core/project-resource-policy';
import type { Env } from './env';
import { ConfigError } from './errors';

export function projectResourceRules(
	env: Env,
	variable: string,
): ProjectResourceRule[] | undefined {
	const value = env[variable]?.trim();
	if (!value) {
		console.warn(
			`${variable} is unset; shared deployment credentials are available across projects. Configure resource/project rules to restrict access.`,
		);
		return undefined;
	}
	try {
		return parseProjectResourceRules(JSON.parse(value));
	} catch {
		throw new ConfigError(`${variable} must be a JSON array of { resource, projects } rules.`, {
			variable,
		});
	}
}
