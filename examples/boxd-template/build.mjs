/**
 * Build the marimo kernel snapshot for the boxd compute backend (`@marimo-hub/compute-boxd`).
 *
 * Parallels examples/sandbox-image (the container-backend kernel image): uv + a
 * pinned marimo (`recommended,ai,sql`) + the warm libs in a reused /opt/venv, so
 * `uv run --no-sync marimo edit` resolves marimo even for a notebook with no
 * pyproject.toml. The script boots a builder machine, installs everything, saves
 * it as a snapshot, and deletes the builder.
 *
 * Run from this directory with a boxd API key in the environment:
 *   BOXD_API_KEY=… pnpm build:snapshot      # or: node build.mjs
 *
 * Set the printed snapshot name as your deployment's `MARIMOHUB_COMPUTE_BOXD_SNAPSHOT`.
 */
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Boxd } from '@boxd-sh/sdk';

// Pin marimo so rebuilds don't silently upgrade it (match your sandbox image).
const MARIMO_VERSION = '0.23.11';
const PYTHON_VERSION = '3.13';
const SNAPSHOT_TIMEOUT_MS = 20 * 60 * 1000;

const name = process.env.BOXD_SNAPSHOT_NAME ?? 'marimo-sandbox';
const org = process.env.BOXD_ORG;
const labels = Object.fromEntries(
	(process.env.BOXD_LABELS ?? '')
		.split(',')
		.filter(Boolean)
		.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
);

const boxd = new Boxd();
const log = (message) => process.stdout.write(`${message}\n`);

async function run(id, command) {
	const result = await boxd.machines.exec(id, { command: ['sh', '-lc', command] });
	if (result.exitCode !== 0) {
		throw new Error(`"${command}" exited ${result.exitCode}:\n${result.stdout}${result.stderr}`);
	}
	return result.stdout;
}

const builder = await boxd.machines.create({
	name: process.env.BOXD_BUILDER_NAME ?? `${name}-builder-${Date.now().toString(36)}`,
	isolated: true,
	labels,
	...(org ? { org } : {}),
});
log(`Builder machine ${builder.name} (${builder.id})`);
try {
	await boxd.machines.waitUntilReady(builder.id);

	await boxd.machines.files.upload(
		builder.id,
		'/tmp/base/pyproject.toml',
		await readFile(new URL('./warm/pyproject.toml', import.meta.url)),
	);
	await boxd.machines.files.upload(
		builder.id,
		'/tmp/marimo.sh',
		await readFile(new URL('./files/marimo.sh', import.meta.url)),
	);

	log('Installing marimo and the warm libraries into /opt/venv');
	await run(
		builder.id,
		[
			'set -e',
			// The kernel runs as the unprivileged exec user, so it owns the venv and workspace.
			'sudo mkdir -p /opt/venv /opt/uv-cache /opt/uv-python /workspace',
			'sudo chown "$(id -u):$(id -g)" /opt/venv /opt/uv-cache /opt/uv-python /workspace',
			'sudo install -m 0644 /tmp/marimo.sh /etc/profile.d/marimo.sh',
			'cd /tmp/base',
			`UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_PROJECT_ENVIRONMENT=/opt/venv UV_CACHE_DIR=/opt/uv-cache uv venv --python ${PYTHON_VERSION} /opt/venv`,
			`UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_PROJECT_ENVIRONMENT=/opt/venv UV_CACHE_DIR=/opt/uv-cache uv add --compile-bytecode "marimo[recommended,ai,sql]==${MARIMO_VERSION}"`,
			'rm -rf /tmp/base /tmp/marimo.sh',
		].join('\n'),
	);
	log((await run(builder.id, 'marimo --version')).trim());

	log(`Saving snapshot "${name}"`);
	const capture = await boxd.snapshots.create(builder.id, name);
	const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
	for (;;) {
		const snapshot = await boxd.snapshots.get(name, org ? { org } : {});
		// `version` is the latest ready one, so a re-save is done once it reaches ours.
		if (snapshot.status === 'ready' && snapshot.version >= capture.version) break;
		if (snapshot.status === 'failed') throw new Error(`Snapshot "${name}" failed`);
		if (Date.now() > deadline) throw new Error(`Snapshot "${name}" was not ready in time`);
		await sleep(2000);
	}
} finally {
	if (process.env.BOXD_KEEP_BUILDER === '1') {
		log(`Kept builder machine ${builder.id}`);
	} else {
		await boxd.machines.delete(builder.id);
	}
}
log(`Built boxd snapshot "${name}".`);
