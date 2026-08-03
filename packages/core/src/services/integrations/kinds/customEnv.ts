import { z } from 'zod';
import { ValidationError } from '../../../errors';
import { assertValidEnvironmentName } from '../environmentName';
import { defineIntegration } from '../sdk';
import { zSecret } from '../secretFields';

// This kind accepts user-defined names, so its form enforces the safe shape and
// `validate` applies the reserved-name policy.
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

const customEnvConfig = z.strictObject({
	vars: z
		.record(z.string().regex(ENV_NAME_PATTERN), z.string())
		.default({})
		.describe('Plain environment variables, visible to project admins'),
	secrets: z
		.array(
			z.strictObject({
				name: z.string().regex(ENV_NAME_PATTERN),
				value: zSecret(),
			}),
		)
		.refine((items) => new Set(items.map(({ name }) => name)).size === items.length, {
			message: 'Duplicate secret environment variable name',
		})
		.meta({ 'x-unique-by': 'name' })
		.default([])
		.describe('Secret environment variables from encrypted values or an external manager'),
	secret_bundles: z
		.array(
			z.strictObject({
				name: z
					.string()
					.regex(ENV_NAME_PATTERN)
					.describe('Stable name used to retain this bundle across edits'),
				value: zSecret().describe('A JSON object containing environment variable values'),
				prefix: z.string().regex(ENV_NAME_PATTERN).optional(),
			}),
		)
		.refine((items) => new Set(items.map(({ name }) => name)).size === items.length, {
			message: 'Duplicate JSON secret bundle name',
		})
		.meta({ 'x-unique-by': 'name' })
		.default([])
		.describe('JSON secret objects expanded into one environment variable per key'),
});

export const customEnv = defineIntegration({
	kind: 'custom_env',
	title: 'Environment variables',
	description: 'Inject a versioned bundle of plain or secret environment variables.',
	category: 'other',
	brand: { color: '#64748B' },
	schemaVersion: 1,
	configSchema: customEnvConfig,
	uiHints: {
		vars: { group: 'Plain variables', order: 1, widget: 'kv-pairs' },
		secrets: { group: 'Secret variables', order: 10 },
		'secrets.*.value': { widget: 'password' },
		secret_bundles: { group: 'JSON secret bundles', order: 20 },
		'secret_bundles.*.value': { widget: 'password' },
	},

	validate(config) {
		const seen = new Set<string>();
		const names = [...Object.keys(config.vars), ...config.secrets.map((s) => s.name)];
		for (const name of names) {
			assertValidEnvironmentName(name);
			if (seen.has(name)) {
				throw new ValidationError(`Env var "${name}" is defined twice in this integration.`);
			}
			seen.add(name);
		}
	},

	render({ config }) {
		const env: Record<string, string> = {};
		const put = (name: string, value: string) => {
			assertValidEnvironmentName(name);
			if (name in env) {
				throw new ValidationError(`Environment variable "${name}" is defined more than once.`);
			}
			env[name] = value;
		};
		for (const [name, value] of Object.entries(config.vars)) put(name, value);
		for (const secret of config.secrets) put(secret.name, secret.value);
		for (const bundle of config.secret_bundles) {
			for (const [name, value] of Object.entries(expandBundle(bundle.value, bundle.prefix))) {
				put(name, value);
			}
		}
		return {
			env,
		};
	},
});

function expandBundle(value: string, prefix = ''): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ValidationError('A JSON secret bundle did not resolve to a JSON object.');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new ValidationError('A JSON secret bundle did not resolve to a JSON object.');
	}
	return Object.fromEntries(
		Object.entries(parsed).map(([key, item]) => {
			const name = `${prefix}${key}`;
			assertValidEnvironmentName(name);
			return [name, typeof item === 'string' ? item : JSON.stringify(item)];
		}),
	);
}
