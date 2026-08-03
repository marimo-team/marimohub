import { z } from 'zod';
import { defineIntegration } from '../sdk';
import {
	connectionUrl,
	hostField,
	portField,
	renderSqlConnection,
	SQL_CONNECTION_HINTS,
	sqlCredentials,
} from './common';

// The two dialects differ in what they can express, not just in what they
// import: pyodbc takes explicit `Encrypt` / `TrustServerCertificate` keywords,
// while pymssql leaves encryption to FreeTDS negotiation. Making the driver the
// discriminator keeps the TLS fields on the branch that actually honours them.
const driverSchema = z
	.discriminatedUnion('name', [
		z.object({
			name: z.literal('pyodbc'),
			odbc_driver: z
				.string()
				.regex(/^[A-Za-z0-9 ._-]+$/, 'ODBC driver name only')
				.default('ODBC Driver 18 for SQL Server')
				.describe('Must be installed in the sandbox image'),
			encrypt: z.boolean().default(true),
			trust_server_certificate: z
				.boolean()
				.default(false)
				.describe('Accept any server certificate — encrypts without authenticating'),
		}),
		z.object({ name: z.literal('pymssql') }),
	])
	.default({ name: 'pyodbc' });

const sqlServerConfig = z.object({
	host: hostField('Server hostname, e.g. mssql.internal'),
	port: portField(1433),
	database: z.string().min(1),
	...sqlCredentials,
	driver: driverSchema,
});

export const sqlserver = defineIntegration({
	kind: 'sqlserver',
	title: 'Microsoft SQL Server',
	description: 'SQL Server or Azure SQL connection for SQL cells and SQLAlchemy.',
	category: 'database',
	brand: { color: '#CC2927' },
	schemaVersion: 1,
	configSchema: sqlServerConfig,
	requirements: ['sqlalchemy>=2', 'pyodbc>=5.1', 'pymssql>=2.3'],
	uiHints: {
		...SQL_CONNECTION_HINTS,
		driver: { group: 'Driver', order: 20 },
		'driver.encrypt': { widget: 'toggle' },
		'driver.trust_server_certificate': { widget: 'toggle' },
	},

	render({ config, instanceName }) {
		const { driver } = config;
		const url = connectionUrl({
			scheme: driver.name === 'pyodbc' ? 'mssql+pyodbc' : 'mssql+pymssql',
			host: config.host,
			port: config.port,
			segments: [config.database],
			username: config.username,
			password: config.password,
			query:
				driver.name === 'pyodbc'
					? {
							driver: driver.odbc_driver,
							Encrypt: driver.encrypt ? 'yes' : 'no',
							TrustServerCertificate: driver.trust_server_certificate ? 'yes' : 'no',
						}
					: {},
		});
		return renderSqlConnection({
			tool: 'MSSQL',
			dir: 'sqlserver',
			instanceName,
			url,
			config,
			descriptor: { driver },
		});
	},
});
