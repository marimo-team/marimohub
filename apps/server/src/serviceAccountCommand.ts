import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { generateServiceAccountToken } from '@marimo-hub/core';
import { parseServiceAccountsConfig } from '@marimo-hub/config/service-accounts';

export const SERVICE_ACCOUNT_HELP = `Usage: service-account generate --account ID --key ID --output-dir PATH [options]

Generate an offline credential for deployment automation.

  --account ID           Stable service-account ID
  --key ID               New credential ID, unique within the account
  --output-dir PATH      New directory for accounts.json and token (must not exist)
  --config PATH          Existing accounts.json; preserve all accounts and keys
  --expires-in-days DAYS Token lifetime, from 1 to 3650 days (default: 90)
  --help                 Show this help

Set server MARIMOHUB_SERVICE_ACCOUNTS to the contents of accounts.json.
Use token as the client's MARIMOHUB_TOKEN_FILE. No secrets are printed.
`;

export async function runServiceAccountCommand(args: string[]): Promise<void> {
	if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
		process.stdout.write(SERVICE_ACCOUNT_HELP);
		return;
	}
	if (args[0] !== 'generate') throw new Error('Expected service-account generate; use --help');
	const { values } = parseArgs({
		args: args.slice(1),
		options: {
			account: { type: 'string' },
			key: { type: 'string' },
			'output-dir': { type: 'string' },
			config: { type: 'string' },
			'expires-in-days': { type: 'string', default: '90' },
			help: { type: 'boolean' },
		},
		allowPositionals: false,
	});
	if (values.help) {
		process.stdout.write(SERVICE_ACCOUNT_HELP);
		return;
	}
	const outputDir = values['output-dir'];
	if (!values.account || !values.key || !outputDir?.trim())
		throw new Error('--account, --key, and --output-dir are required');
	const days = Number(values['expires-in-days']);
	if (
		!/^\d+$/.test(values['expires-in-days']) ||
		!Number.isInteger(days) ||
		days < 1 ||
		days > 3650
	)
		throw new Error('--expires-in-days must be an integer from 1 to 3650');
	const accounts = parseServiceAccountsConfig(
		values.config === undefined ? '[]' : await readFile(values.config, 'utf8'),
	);
	const { token, credential } = await generateServiceAccountToken(values.account, values.key);
	credential.expires_at = new Date(Date.now() + days * 86_400_000).toISOString();
	const account = accounts.find((entry) => entry.id === values.account);
	if (account) {
		if (account.credentials.some((entry) => entry.id === values.key))
			throw new Error('Credential ID already exists; use a new --key for rotation');
		account.credentials.push(credential);
	} else {
		accounts.push({
			id: values.account,
			actions: ['org-integration.manage'],
			credentials: [credential],
		});
	}
	const json = `${JSON.stringify(accounts, null, 2)}\n`;
	parseServiceAccountsConfig(json);
	// Exclusive directory creation prevents overwrites and keeps partial output private.
	await mkdir(outputDir, { mode: 0o700 });
	try {
		await writeFile(join(outputDir, 'accounts.json'), json, { flag: 'wx', mode: 0o600 });
		await writeFile(join(outputDir, 'token'), `${token}\n`, { flag: 'wx', mode: 0o600 });
	} catch (error) {
		await rm(outputDir, { recursive: true, force: true });
		throw error;
	}
}
