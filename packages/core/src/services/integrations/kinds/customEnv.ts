import { z } from 'zod';
import { ValidationError } from '../../../errors';
import { assertValidSecretName } from '../../secrets/secretName';
import { defineIntegration } from '../sdk';
import { zSecret } from '../secretFields';

// The one kind whose env names are USER input, so they get the full
// project-secret name policy (POSIX shape, reserved names, hub prefixes) —
// shape here for form-time feedback, the blocklist in `validate` below.
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

const customEnvConfig = z.object({
	vars: z
		.record(z.string().regex(ENV_NAME_PATTERN), z.string())
		.default({})
		.describe('Plain environment variables, visible to project admins'),
	secrets: z
		.array(
			z.object({
				name: z.string().regex(ENV_NAME_PATTERN),
				value: zSecret(),
			}),
		)
		.default([])
		.describe('Secret environment variables, write-only after save'),
});

export const customEnv = defineIntegration({
	kind: 'custom_env',
	title: 'Custom environment',
	description: 'Inject arbitrary environment variables — plain or secret — into every session.',
	category: 'other',
	brand: { color: '#64748B' },
	schemaVersion: 1,
	configSchema: customEnvConfig,
	uiHints: {
		vars: { group: 'Variables', order: 1, widget: 'kv-pairs' },
		secrets: { group: 'Secrets', order: 10 },
		'secrets.*.value': { widget: 'password' },
	},

	validate(config) {
		const seen = new Set<string>();
		const names = [...Object.keys(config.vars), ...config.secrets.map((s) => s.name)];
		for (const name of names) {
			assertValidSecretName(name);
			if (seen.has(name)) {
				throw new ValidationError(`Env var "${name}" is defined twice in this integration.`);
			}
			seen.add(name);
		}
	},

	render({ config }) {
		return {
			env: {
				...config.vars,
				...Object.fromEntries(config.secrets.map((s) => [s.name, s.value])),
			},
		};
	},
});
