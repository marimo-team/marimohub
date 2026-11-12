import { integration, secret } from '@marimo-hub/iac';
import { runIntegrations } from '@marimo-hub/iac/runner';

const host = Deno.env.get('WAREHOUSE_HOST');
if (!host) throw new Error('Missing WAREHOUSE_HOST');

Deno.exit(
	await runIntegrations(
		[
			integration('postgres', 'warehouse', {
				host,
				database: 'analytics',
				username: 'reader',
				password: secret.ref('aws-sm', 'prod/warehouse#password'),
			}),
		],
		{
			get: (name) => Deno.env.get(name),
			out: console.log,
			err: console.error,
		},
		Deno.args,
	),
);
