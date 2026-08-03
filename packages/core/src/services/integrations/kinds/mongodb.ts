import { z } from 'zod';
import { defineIntegration } from '../sdk';
import { zSecret } from '../secretFields';
import {
	caFields,
	connectionUrl,
	hostField,
	portField,
	renderConnection,
	resolveCaPath,
	validateCaFields,
} from './common';

const mongoConfig = z.strictObject({
	// `mongodb+srv` resolves the replica-set members from DNS, which is how Atlas
	// and most managed deployments are addressed. A seed list of literal members
	// is deliberately not modelled: one host keeps the rendered URI unambiguous.
	scheme: z.enum(['mongodb+srv', 'mongodb']).default('mongodb+srv'),
	host: hostField('Cluster hostname, e.g. cluster0.abcde.mongodb.net'),
	port: portField(27017).describe('Ignored for mongodb+srv'),
	database: z.string().min(1).optional().describe('Default database for `client.get_database()`'),
	auth: z
		.discriminatedUnion('method', [
			z.strictObject({
				method: z.literal('password'),
				username: z.string().min(1),
				password: zSecret(),
				auth_source: z.string().min(1).default('admin'),
			}),
			z.strictObject({ method: z.literal('none') }),
		])
		.default({ method: 'none' }),
	tls: z
		.discriminatedUnion('mode', [
			z.strictObject({ mode: z.literal('enabled'), ...caFields }),
			z.strictObject({ mode: z.literal('disabled') }),
		])
		.default({ mode: 'enabled' }),
});

export const mongodb = defineIntegration({
	kind: 'mongodb',
	title: 'MongoDB',
	description: 'MongoDB or Atlas cluster reachable from PyMongo.',
	category: 'database',
	brand: { icon: 'mongodb', color: '#47A248' },
	schemaVersion: 1,
	configSchema: mongoConfig,
	requirements: ['pymongo>=4.9'],
	uiHints: {
		scheme: { group: 'Connection', order: 1 },
		host: { group: 'Connection', order: 2 },
		port: { group: 'Connection', order: 3, widget: 'number' },
		database: { group: 'Connection', order: 4 },
		tls: { group: 'Connection', order: 5 },
		'tls.ca_bundle': { widget: 'textarea' },
		auth: { group: 'Authentication', order: 10 },
		'auth.password': { widget: 'password' },
	},

	validate(config) {
		if (config.tls.mode === 'enabled') validateCaFields(config.tls, 'tls');
	},

	render({ config, instanceName }) {
		const files: { path: string; content: string }[] = [];
		const srv = config.scheme === 'mongodb+srv';
		// `tlsCAFile` is only rendered for custom trust material: PyMongo already
		// verifies against the image's own store, so naming it would be noise.
		let caPath: string | undefined;
		if (config.tls.mode === 'enabled' && (config.tls.ca_bundle ?? config.tls.ca_path)) {
			caPath = resolveCaPath({ trust: config.tls, dir: 'mongodb', instanceName, files });
		}
		const url = connectionUrl({
			scheme: config.scheme,
			host: config.host,
			port: srv ? undefined : config.port,
			segments: [config.database],
			username: config.auth.method === 'password' ? config.auth.username : undefined,
			password: config.auth.method === 'password' ? config.auth.password : undefined,
			query: {
				...(config.auth.method === 'password' ? { authSource: config.auth.auth_source } : {}),
				tls: String(config.tls.mode === 'enabled'),
				tlsCAFile: caPath,
			},
		});
		return renderConnection({
			tool: 'MONGODB',
			dir: 'mongodb',
			instanceName,
			fields: {
				URL: url,
				HOST: config.host,
				PORT: srv ? undefined : config.port,
				DATABASE: config.database,
				USER: config.auth.method === 'password' ? config.auth.username : undefined,
				PASSWORD: config.auth.method === 'password' ? config.auth.password : undefined,
			},
			secretFields: ['URL', 'PASSWORD'],
			descriptor: {
				scheme: config.scheme,
				tls: { mode: config.tls.mode, ...(caPath ? { ca_path: caPath } : {}) },
			},
			files,
			manifestExtra: { host: config.host, database: config.database },
		});
	},
});
