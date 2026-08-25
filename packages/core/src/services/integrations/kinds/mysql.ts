import { z } from 'zod';
import { defineIntegration } from '../sdk';
import {
	caFields,
	connectionUrl,
	discoveryEnvField,
	hostField,
	portField,
	renderSqlConnection,
	resolveCaPath,
	SQL_CONNECTION_HINTS,
	sqlCredentials,
	validateCaFields,
} from './common';

// PyMySQL takes its TLS settings as a `ssl` dict built from the URL's `ssl_*`
// query arguments, which SQLAlchemy passes through as strings — and a non-empty
// string is truthy in Python. The intermediate MySQL modes (encrypt without
// verifying, verify the chain but not the hostname) are spelled with those
// boolean-ish arguments, so offering them here would mean rendering a URL whose
// meaning depends on how a given driver version coerces `"false"`. Naming a CA
// bundle is unambiguous in every version: it verifies the chain and, through
// Python's default SSL context, the hostname too.
const sslSchema = z
	.discriminatedUnion('mode', [
		z.strictObject({ mode: z.literal('verify_identity'), ...caFields }),
		z.strictObject({ mode: z.literal('disabled') }),
	])
	.default({ mode: 'verify_identity' })
	.describe('`verify_identity` checks the CA chain and the hostname; `disabled` is plaintext');

const mysqlConfig = z.strictObject({
	host: hostField('Server hostname, e.g. mysql.internal'),
	port: portField(3306),
	database: z.string().min(1),
	...sqlCredentials,
	ssl: sslSchema,
	ambient_env: discoveryEnvField(
		'MYSQL_HOST, MYSQL_TCP_PORT, MYSQL_DATABASE, MYSQL_USER, and MYSQL_PASSWORD',
	),
});

export const mysql = defineIntegration({
	kind: 'mysql',
	title: 'MySQL',
	description: 'Direct MySQL or MariaDB connection for SQL cells and SQLAlchemy.',
	category: 'database',
	brand: { icon: 'mysql', color: '#4479A1' },
	schemaVersion: 1,
	configSchema: mysqlConfig,
	environmentVariables: [
		'MYSQL_HOST',
		'MYSQL_TCP_PORT',
		'MYSQL_DATABASE',
		'MYSQL_USER',
		'MYSQL_PASSWORD',
	],
	requirements: ['sqlalchemy>=2', 'pymysql>=1.1'],
	uiHints: {
		...SQL_CONNECTION_HINTS,
		ssl: { group: 'Connection', order: 4 },
		'ssl.ca_bundle': { widget: 'textarea' },
		ambient_env: { group: 'Discovery', order: 60, widget: 'toggle' },
	},

	validate(config) {
		if (config.ssl.mode === 'verify_identity') validateCaFields(config.ssl, 'ssl');
	},

	render({ config, instanceName }) {
		const files: { path: string; content: string }[] = [];
		const caPath =
			config.ssl.mode === 'disabled'
				? undefined
				: resolveCaPath({ trust: config.ssl, dir: 'mysql', instanceName, files });
		const url = connectionUrl({
			scheme: 'mysql+pymysql',
			host: config.host,
			port: config.port,
			segments: [config.database],
			username: config.username,
			password: config.password,
			query: { ssl_ca: caPath },
		});
		return renderSqlConnection({
			tool: 'MYSQL',
			dir: 'mysql',
			instanceName,
			url,
			config,
			discovery:
				config.ambient_env && config.ssl.mode === 'disabled'
					? {
							MYSQL_HOST: config.host,
							MYSQL_TCP_PORT: String(config.port),
							MYSQL_DATABASE: config.database,
							MYSQL_USER: config.username,
							MYSQL_PASSWORD: config.password,
						}
					: {},
			warnings:
				config.ambient_env && config.ssl.mode !== 'disabled'
					? [
							`Integration "${instanceName}" is available through its notebook snippet, but not ` +
								'automatic data-source discovery because marimo cannot carry its MySQL TLS settings.',
						]
					: [],
			descriptor: {
				ssl: { mode: config.ssl.mode, ...(caPath ? { ca_path: caPath } : {}) },
			},
			files,
		});
	},
});
