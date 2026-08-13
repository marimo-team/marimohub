import { fileURLToPath } from 'node:url';
import type { ApiDeps } from '@marimo-hub/api';
import { ensureInitialized, UserId, ValidationError } from '@marimo-hub/core';
import type { CreateIntegrationInput, CreateNotebookInput } from '@marimo-hub/core';

const DEV_STORAGE_ROOT = fileURLToPath(new URL('../../../.context/dev-storage', import.meta.url));

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
	await ensureInitialized(deps.bucket, DEV_USER.id);
	const projects = await deps.services.projects.listProjects();
	const project = projects.find(({ name }) => name === 'My Projects') ?? projects[0];
	if (project) {
		const notebooks = await deps.services.notebooks.listNotebooks(project.id);
		if (!notebooks.some(({ title }) => title === DEV_NOTEBOOK.title)) {
			await deps.services.notebooks.createNotebook(project.id, DEV_NOTEBOOK, DEV_USER.id);
		}
	}

	const integrations = deps.orgIntegrations;
	if (!integrations) throw new Error('Local development integrations are not enabled.');
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
