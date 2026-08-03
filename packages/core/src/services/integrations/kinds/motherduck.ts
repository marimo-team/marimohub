import { z } from 'zod';
import { defineIntegration } from '../sdk';
import { zSecret } from '../secretFields';
import { renderConnection } from './common';

const motherduckConfig = z.object({
	token: zSecret().describe('MotherDuck service token'),
	database: z
		.string()
		.regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, underscores, and hyphens only')
		.optional()
		.describe('Database to attach; omit to attach every database in the account'),
	saas_mode: z
		.boolean()
		.default(false)
		.describe('Block local file and extension access from the MotherDuck session'),
});

export const motherduck = defineIntegration({
	kind: 'motherduck',
	title: 'MotherDuck',
	description: 'MotherDuck cloud DuckDB, attached from a duckdb connection.',
	category: 'database',
	brand: { icon: 'duckdb', color: '#FFF000' },
	schemaVersion: 1,
	configSchema: motherduckConfig,
	requirements: ['duckdb>=1.1'],
	uiHints: {
		token: { group: 'Authentication', order: 1, widget: 'password' },
		database: { group: 'Connection', order: 10 },
		saas_mode: { group: 'Connection', order: 11, widget: 'toggle', advanced: true },
	},

	render({ config, instanceName }) {
		// DuckDB's own `motherduck_token` variable is lower-case, which the bundler
		// rejects (POSIX-shell-safe names only), so the token rides in the `md:`
		// connection string instead.
		const query = new URLSearchParams({ motherduck_token: config.token });
		if (config.saas_mode) query.set('saas_mode', 'true');
		return renderConnection({
			tool: 'MOTHERDUCK',
			dir: 'motherduck',
			instanceName,
			fields: {
				URL: `md:${config.database ?? ''}?${query}`,
				TOKEN: config.token,
				DATABASE: config.database,
				SAAS_MODE: config.saas_mode,
			},
			secretFields: ['URL', 'TOKEN'],
			manifestExtra: { database: config.database },
		});
	},
});
