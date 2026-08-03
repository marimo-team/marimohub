import { z } from 'zod';
import { defineIntegration, HOSTNAME_REGEX } from '../sdk';
import { zSecret } from '../secretFields';
import { connectionUrl, renderConnection, renderFile } from './common';

const authSchema = z.discriminatedUnion('method', [
	z.object({ method: z.literal('password'), password: zSecret() }),
	z.object({
		method: z.literal('key_pair'),
		private_key: zSecret().describe('PKCS#8 private key PEM, written into the session'),
		private_key_passphrase: zSecret().optional(),
	}),
	z.object({ method: z.literal('oauth'), token: zSecret() }),
]);

const snowflakeConfig = z.object({
	account: z
		.string()
		.regex(HOSTNAME_REGEX, 'Account identifier only — no scheme, path, or credentials')
		.describe('Account identifier, e.g. myorg-account1'),
	user: z.string().min(1),
	auth: authSchema,
	warehouse: z.string().min(1).optional().describe('Warehouse the session runs on'),
	database: z.string().min(1).optional().describe('Session default database'),
	schema: z.string().min(1).optional().describe('Session default schema'),
	role: z.string().min(1).optional().describe('Role the session assumes'),
});

export const snowflake = defineIntegration({
	kind: 'snowflake',
	title: 'Snowflake',
	description: 'Snowflake warehouse connection for SQL cells and SQLAlchemy.',
	category: 'database',
	brand: { icon: 'snowflake', color: '#29B5E8' },
	schemaVersion: 1,
	configSchema: snowflakeConfig,
	requirements: ['snowflake-connector-python>=3.12', 'snowflake-sqlalchemy>=1.7'],
	uiHints: {
		account: { group: 'Connection', order: 1 },
		user: { group: 'Connection', order: 2 },
		auth: { group: 'Authentication', order: 10 },
		'auth.password': { widget: 'password' },
		'auth.private_key': { widget: 'textarea' },
		'auth.private_key_passphrase': { widget: 'password' },
		'auth.token': { widget: 'password' },
		warehouse: { group: 'Defaults', order: 20 },
		database: { group: 'Defaults', order: 21 },
		schema: { group: 'Defaults', order: 22 },
		role: { group: 'Defaults', order: 23 },
	},

	render({ config, instanceName }) {
		const files: { path: string; content: string }[] = [];
		const privateKeyPath =
			config.auth.method === 'key_pair'
				? renderFile(files, `snowflake/${instanceName}-key.pem`, config.auth.private_key)
				: undefined;
		// Only a password fits in a URL. Key-pair and OAuth connections are opened
		// from the env vars and descriptor instead, so no URL is rendered for them
		// rather than one that silently omits the credential.
		const url =
			config.auth.method === 'password'
				? connectionUrl({
						scheme: 'snowflake',
						host: config.account,
						username: config.user,
						password: config.auth.password,
						segments: [config.database, config.schema],
						query: { warehouse: config.warehouse, role: config.role },
					})
				: undefined;
		return renderConnection({
			tool: 'SNOWFLAKE',
			dir: 'snowflake',
			instanceName,
			fields: {
				URL: url,
				ACCOUNT: config.account,
				USER: config.user,
				PASSWORD: config.auth.method === 'password' ? config.auth.password : undefined,
				TOKEN: config.auth.method === 'oauth' ? config.auth.token : undefined,
				PRIVATE_KEY_PATH: privateKeyPath,
				PRIVATE_KEY_PASSPHRASE:
					config.auth.method === 'key_pair' ? config.auth.private_key_passphrase : undefined,
				WAREHOUSE: config.warehouse,
				DATABASE: config.database,
				SCHEMA: config.schema,
				ROLE: config.role,
			},
			secretFields: ['URL', 'PASSWORD', 'TOKEN', 'PRIVATE_KEY_PASSPHRASE'],
			descriptor: { authenticator: config.auth.method },
			files,
			manifestExtra: { account: config.account, auth_method: config.auth.method },
		});
	},
});
