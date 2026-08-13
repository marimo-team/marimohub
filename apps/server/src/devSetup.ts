import { randomUUID } from 'node:crypto';
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

const DEV_INTEGRATION = {
	kind: 'custom_env',
	name: 'local-development',
	config: { vars: { LOCAL_DEV_EXAMPLE: 'true' } },
	change_note: 'Seeded by pnpm dev',
} satisfies CreateIntegrationInput;

const DEV_INTEGRATION_CONFLICT = `An integration named "${DEV_INTEGRATION.name}" already exists at the org level.`;

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

async function hasDevIntegration(integrations: NonNullable<ApiDeps['orgIntegrations']>) {
	return (await integrations.list()).some(
		({ kind, name }) => kind === DEV_INTEGRATION.kind && name === DEV_INTEGRATION.name,
	);
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
		MARIMOHUB_DATA_BROWSER: 'metadata',
	};
}

export async function seedLocalDev(
	deps: Pick<ApiDeps, 'bucket' | 'orgIntegrations' | 'services'>,
): Promise<void> {
	const integrations = deps.orgIntegrations;
	if (!integrations) throw new Error('Local development integrations are not enabled.');

	await ensureInitialized(deps.bucket, DEV_USER.id);
	await seedWelcomeNotebook(deps);
	if (await hasDevIntegration(integrations)) return;

	try {
		await integrations.create(DEV_INTEGRATION, DEV_USER.id);
	} catch (error) {
		if (
			error instanceof ValidationError &&
			error.message === DEV_INTEGRATION_CONFLICT &&
			(await hasDevIntegration(integrations))
		)
			return;
		throw error;
	}
}
