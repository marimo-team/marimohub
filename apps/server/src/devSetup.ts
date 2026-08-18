import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiDeps } from '@marimo-hub/api';
import {
	acquireSingletonClaim,
	ensureInitialized,
	mutateObjectWithOutcome,
	releaseSingletonClaim,
	sleep,
	UserId,
	ValidationError,
} from '@marimo-hub/core';
import type { CreateIntegrationInput, CreateNotebookInput } from '@marimo-hub/core';

const DEV_STORAGE_ROOT = fileURLToPath(new URL('../../../.context/dev-storage', import.meta.url));
const DEV_NOTEBOOK_SEED_CLAIM = '_system/dev/local-notebook-seed.json';
const DEV_NOTEBOOK_SEED_LEASE_MS = 30_000;
const DEV_NOTEBOOK_SEED_RENEW_MS = DEV_NOTEBOOK_SEED_LEASE_MS / 3;
const DEV_NOTEBOOK_SEED_WAIT_MS = DEV_NOTEBOOK_SEED_LEASE_MS + 5_000;
const DEV_NOTEBOOK_SEED_POLL_MS = 25;

const DEV_USER = {
	id: UserId.parse('user'),
	email: 'user@localhost',
	name: 'Local Dev Super Admin',
} as const;

const DEV_KEK_PATH = fileURLToPath(new URL('../../../.context/dev-secrets-kek', import.meta.url));

function readDevKek(): string | undefined {
	try {
		return readFileSync(DEV_KEK_PATH, 'utf8').trim() || undefined;
	} catch {
		return undefined;
	}
}

// A committed KEK would let anyone with the source decrypt persisted dev
// secrets, so generate a random one instead. Ephemeral storage gets a
// per-process key; MARIMOHUB_DEV_PERSIST needs the same key across restarts,
// so it is kept in the gitignored .context dir (created once, `wx` so a
// concurrent startup keeps the winner's key).
function devSecretsKek(durableStorage: boolean): string {
	if (!durableStorage) return randomBytes(32).toString('base64');
	const existing = readDevKek();
	if (existing) return existing;
	const kek = randomBytes(32).toString('base64');
	mkdirSync(dirname(DEV_KEK_PATH), { recursive: true });
	try {
		writeFileSync(DEV_KEK_PATH, `${kek}\n`, { flag: 'wx', mode: 0o600 });
		return kek;
	} catch {
		return readDevKek() ?? kek;
	}
}

const DEV_INTEGRATION = {
	kind: 'custom_env',
	name: 'local-development',
	config: { vars: { LOCAL_DEV_EXAMPLE: 'true' } },
	change_note: 'Seeded by pnpm dev',
} satisfies CreateIntegrationInput;

// Fixed endpoints from scripts/dev-services/compose.yaml (`pnpm dev:services`).
const DEV_S3_ENDPOINT = 'http://127.0.0.1:19000';
const DEV_ICEBERG_URI = 'http://127.0.0.1:18181';
const DEV_SERVICE_CREDENTIALS = { access_key_id: 'minioadmin', secret_access_key: 'minioadmin' };
const DEV_SERVICE_PROBE_TIMEOUT_MS = 1_500;

const DEV_SERVICE_INTEGRATIONS: readonly { healthUrl: string; input: CreateIntegrationInput }[] = [
	{
		healthUrl: `${DEV_S3_ENDPOINT}/minio/health/live`,
		input: {
			kind: 's3',
			name: 'local-minio',
			config: {
				bucket: 'dev-data',
				region: 'us-east-1',
				endpoint_url: DEV_S3_ENDPOINT,
				path_style: true,
				ambient_env: false,
				auth: { method: 'static', ...DEV_SERVICE_CREDENTIALS },
			},
			change_note: 'Seeded by pnpm dev (MinIO from pnpm dev:services)',
		},
	},
	{
		healthUrl: `${DEV_ICEBERG_URI}/v1/config`,
		input: {
			kind: 'iceberg_rest',
			name: 'local-iceberg',
			config: {
				uri: DEV_ICEBERG_URI,
				allow_insecure_transport: true,
				auth: { method: 'none' },
				access_delegation: 'none',
				// The fixture vends no client S3 config, so readers need the endpoint,
				// credentials, and broker authorization prefix spelled out.
				storage: {
					scheme: 's3',
					region: 'us-east-1',
					endpoint: DEV_S3_ENDPOINT,
					credentials: { method: 'static', ...DEV_SERVICE_CREDENTIALS },
					broker_read_locations: [{ bucket: 'warehouse', prefix: 'demo' }],
				},
			},
			change_note: 'Seeded by pnpm dev (Iceberg REST from pnpm dev:services)',
		},
	},
];

function integrationConflict(name: string): string {
	return `An integration named "${name}" already exists at the org level.`;
}

const DEV_NOTEBOOK = {
	title: 'Welcome to marimohub',
	description: 'A small notebook for trying the local development stack.',
	code: `import marimo

__generated_with = "0.16.0"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    return (mo,)


@app.cell
def _(mo):
    slider = mo.ui.slider(1, 10, value=5, label="Pick a number")
    slider
    return (slider,)


@app.cell
def _(mo, slider):
    mo.md(f"Your number squared is **{slider.value ** 2}**.")
    return


if __name__ == "__main__":
    app.run()
`,
	tags: ['example'],
	readme: '# Welcome to marimohub\n\nEdit and run this notebook with the local compute backend.\n',
} satisfies CreateNotebookInput;

async function hasIntegration(
	integrations: NonNullable<ApiDeps['orgIntegrations']>,
	input: CreateIntegrationInput,
) {
	return (await integrations.list()).some(
		({ kind, name }) => kind === input.kind && name === input.name,
	);
}

async function seedIntegration(
	integrations: NonNullable<ApiDeps['orgIntegrations']>,
	input: CreateIntegrationInput,
): Promise<void> {
	if (await hasIntegration(integrations, input)) return;
	try {
		await integrations.create(input, DEV_USER.id);
	} catch (error) {
		// A concurrent startup may have claimed the name first; only a same-kind
		// duplicate is benign.
		if (
			error instanceof ValidationError &&
			error.message === integrationConflict(input.name) &&
			(await hasIntegration(integrations, input))
		)
			return;
		throw error;
	}
}

async function serviceReachable(healthUrl: string): Promise<boolean> {
	try {
		const response = await fetch(healthUrl, {
			signal: AbortSignal.timeout(DEV_SERVICE_PROBE_TIMEOUT_MS),
		});
		return response.ok;
	} catch {
		return false;
	}
}

function parseSeedClaim(raw: unknown): string | null {
	if (typeof raw !== 'object' || raw === null || !('holder' in raw)) {
		throw new Error('Invalid local development seed claim');
	}
	const holder = raw.holder;
	if (holder === null || typeof holder === 'string') return holder;
	throw new Error('Invalid local development seed claim');
}

function renewSeedHolder(holder: string): string | null {
	const match = /^(\d+):\d+:(.+)$/.exec(holder);
	return match ? `${match[1]}:${Date.now()}:${match[2]}` : null;
}

async function isSeedProcessLive(holder: string): Promise<boolean> {
	const match = /^(\d+):(\d+):/.exec(holder);
	const pid = Number(match?.[1]);
	const claimedAt = Number(match?.[2]);
	const age = Date.now() - claimedAt;
	if (
		!Number.isSafeInteger(pid) ||
		pid <= 0 ||
		!Number.isSafeInteger(claimedAt) ||
		age < 0 ||
		age >= DEV_NOTEBOOK_SEED_LEASE_MS
	)
		return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
	}
}

async function acquireSeedClaim(
	claim: Parameters<typeof acquireSingletonClaim>[0],
	holder: string,
): Promise<void> {
	const deadline = Date.now() + DEV_NOTEBOOK_SEED_WAIT_MS;
	for (;;) {
		if ((await acquireSingletonClaim(claim, holder)).acquired) return;
		const remaining = deadline - Date.now();
		if (remaining <= 0)
			throw new Error('Timed out waiting to seed the local development notebook.');
		await sleep(Math.min(DEV_NOTEBOOK_SEED_POLL_MS, remaining));
	}
}

async function renewSeedClaim(
	deps: Pick<ApiDeps, 'bucket'>,
	holder: string,
): Promise<string | null> {
	const renewed = renewSeedHolder(holder);
	if (!renewed) return null;
	const result = await mutateObjectWithOutcome(
		deps.bucket,
		DEV_NOTEBOOK_SEED_CLAIM,
		(raw) => ({ holder: parseSeedClaim(raw) }),
		(current) => (current.holder === holder ? { holder: renewed } : null),
	);
	return result.written ? renewed : null;
}

async function seedWelcomeNotebook(deps: Pick<ApiDeps, 'bucket' | 'services'>): Promise<void> {
	let holder = `${process.pid}:${Date.now()}:${randomUUID()}`;
	const claim = {
		bucket: deps.bucket,
		key: DEV_NOTEBOOK_SEED_CLAIM,
		serialize: (value: string | null) => JSON.stringify({ holder: value }),
		parseHolder: parseSeedClaim,
		isHolderLive: isSeedProcessLive,
	};
	await acquireSeedClaim(claim, holder);
	let renewal: Promise<void> | undefined;
	let renewalError: Error | undefined;
	const renew = (): Promise<void> => {
		if (renewal) return renewal;
		const pending = renewSeedClaim(deps, holder).then((next) => {
			if (!next) throw new Error('Lost the local development notebook seed lease.');
			holder = next;
		});
		const tracked = pending
			.catch((error: unknown) => {
				renewalError = error instanceof Error ? error : new Error(String(error));
				throw renewalError;
			})
			.finally(() => {
				if (renewal === tracked) renewal = undefined;
			});
		renewal = tracked;
		return tracked;
	};
	const renewalTimer = setInterval(() => void renew().catch(() => {}), DEV_NOTEBOOK_SEED_RENEW_MS);

	try {
		const projects = await deps.services.projects.listProjects();
		const project = projects.find(({ name }) => name === 'My Projects') ?? projects[0];
		if (!project) return;
		const notebooks = await deps.services.notebooks.listNotebooks(project.id);
		if (!notebooks.some(({ title }) => title === DEV_NOTEBOOK.title)) {
			await renew();
			await deps.services.notebooks.createNotebook(project.id, DEV_NOTEBOOK, DEV_USER.id);
		}
		await renewal;
		if (renewalError) throw renewalError;
	} finally {
		clearInterval(renewalTimer);
		await renewal?.catch(() => {});
		await releaseSingletonClaim(claim, holder);
	}
}

export function localDevEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const durableStorage = env.MARIMOHUB_DEV_PERSIST === 'true';
	return {
		...env,
		MARIMOHUB_STORAGE_BACKEND: durableStorage ? 'fs' : 'memory',
		MARIMOHUB_ALLOW_EPHEMERAL_STORAGE: durableStorage ? 'false' : 'true',
		MARIMOHUB_STORAGE_FS_ROOT: durableStorage ? DEV_STORAGE_ROOT : undefined,
		MARIMOHUB_COMPUTE_BACKEND: 'local',
		MARIMOHUB_AUTH_BACKEND: 'dev',
		MARIMOHUB_AUTH_DEV_USER_ID: DEV_USER.id,
		MARIMOHUB_AUTH_DEV_EMAIL: DEV_USER.email,
		MARIMOHUB_AUTH_DEV_NAME: DEV_USER.name,
		MARIMOHUB_SUPER_ADMINS: DEV_USER.email,
		MARIMOHUB_INTEGRATIONS: 'on',
		MARIMOHUB_INTEGRATIONS_PROBE: 'private',
		MARIMOHUB_DATA_BROWSER: 'full',
		// Inert with the local compute backend (no per-sandbox image overrides),
		// but keeps the config honest for anyone pointing dev at a real backend.
		MARIMOHUB_DATA_PREVIEW_IMAGE:
			env.MARIMOHUB_DATA_PREVIEW_IMAGE ?? 'ghcr.io/marimo-team/marimo-sandbox:latest',
		MARIMOHUB_EXPERIMENTS: env.MARIMOHUB_EXPERIMENTS ?? 'duckdb-wasm-preview,duckdb-wasm-sql',
		MARIMOHUB_SECRETS_KEK: env.MARIMOHUB_SECRETS_KEK ?? devSecretsKek(durableStorage),
	};
}

export async function seedLocalDev(
	deps: Pick<ApiDeps, 'bucket' | 'orgIntegrations' | 'services'>,
	env: Record<string, string | undefined> = process.env,
): Promise<void> {
	const integrations = deps.orgIntegrations;
	if (!integrations) throw new Error('Local development integrations are not enabled.');

	await ensureInitialized(deps.bucket, DEV_USER.id);
	await seedWelcomeNotebook(deps);
	await seedIntegration(integrations, DEV_INTEGRATION);

	if (env.MARIMOHUB_DEV_SERVICES?.trim().toLowerCase() === 'off') return;
	for (const service of DEV_SERVICE_INTEGRATIONS) {
		if (await serviceReachable(service.healthUrl)) {
			await seedIntegration(integrations, service.input);
		}
	}
}
