import { rejects } from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConflictError, createSandboxId, createServices, paths, UserId } from '@marimo-hub/core';
import type { Session } from '@marimo-hub/core';
import { makeStorage } from '../../../../packages/config/src/storage';

const [root, operation, boundary, unchanged] = process.argv.slice(2);
const bucket = makeStorage({
	MARIMOHUB_STORAGE_BACKEND: 'fs',
	MARIMOHUB_STORAGE_FS_ROOT: join(root, 'bucket'),
});
const services = createServices(bucket);
const actor = UserId.parse('capture-crash-test');
const manifest = join(root, 'session.json');

function artifacts(generation: string) {
	return {
		code: unchanged === 'true' ? '# unchanged' : `# ${generation}`,
		deps: '[project]\nname = "capture"',
		session: JSON.stringify({
			cells: [{ code_hash: generation, outputs: [{ data: { 'text/plain': generation } }] }],
		}),
	};
}

async function barrier(phase: string) {
	if (boundary !== phase) return;
	process.send!({ phase });
	await new Promise<never>(() => {
		setInterval(() => {}, 1000);
	});
}

async function capture(session: Session, generation: string) {
	const token = await services.notebooks.beginSessionCapture(
		session.project_id,
		session.notebook_id,
	);
	await services.sessions.assertCaptureOwnership(session);
	await services.sessions.recordCaptureAttempt(session);
	const result = await services.notebooks.commitSession(
		session.project_id,
		session.notebook_id,
		artifacts(generation),
		actor,
		token,
	);
	if (!result) throw new Error('Capture was not published');
	await barrier('receipt-before');
	await services.sessions.recordDurableCapture(session, new Date().toISOString(), result.versionId);
	await barrier('receipt-after');
}

async function main() {
	if (operation === 'fail') throw new Error('Requested startup failure');
	if (operation === 'hang')
		await new Promise<never>(() => {
			setInterval(() => {}, 1000);
		});
	if (operation === 'unexpected') {
		process.send!({ phase: 'unexpected' });
		await new Promise<never>(() => {
			setInterval(() => {}, 1000);
		});
	}
	if (operation === 'seed') {
		await services.catalog.initialize(actor);
		const project = await services.projects.createProject(
			{ name: 'Capture', description: '' },
			actor,
		);
		const notebook = await services.notebooks.createNotebook(
			project.id,
			{ title: 'Capture', description: '', code: '# initial' },
			actor,
		);
		const session = await services.sessions.createSession({
			project_id: project.id,
			notebook_id: notebook.id,
			user_id: actor,
			sandbox_id: createSandboxId(),
		});
		await services.sessions.claimEditor(project.id, notebook.id, session.session_id, 'shared');
		await writeFile(manifest, JSON.stringify(session));
		await capture(session, 'durable');
		await writeFile(
			join(root, 'publication.json'),
			JSON.stringify(await services.notebooks.beginSessionCapture(project.id, notebook.id)),
		);
	}
	const identity = JSON.parse(await readFile(manifest, 'utf8')) as Session;
	let session = await services.sessions.getSession(identity.project_id, identity.session_id);
	const nb = paths.project(session.project_id).notebook(session.notebook_id);
	if (operation === 'replace') {
		await services.sessions.releaseEditorFor(session);
		const replacement = await services.sessions.createSession({
			project_id: session.project_id,
			notebook_id: session.notebook_id,
			user_id: actor,
			sandbox_id: createSandboxId(),
		});
		await services.sessions.claimEditor(
			session.project_id,
			session.notebook_id,
			replacement.session_id,
			'shared',
		);
	}
	if (operation === 'stale') {
		const token = JSON.parse(await readFile(join(root, 'publication.json'), 'utf8')) as Awaited<
			ReturnType<typeof services.notebooks.beginSessionCapture>
		>;
		await rejects(
			services.notebooks.commitSession(
				session.project_id,
				session.notebook_id,
				artifacts('stale'),
				actor,
				token,
			),
			ConflictError,
		);
	}
	if (operation === 'capture') {
		session = await services.sessions.acknowledgeRuntimeSave(
			session.project_id,
			session.session_id,
		);
		const put = bucket.put.bind(bucket);
		bucket.put = async (key, value, options) => {
			if (key.includes('/captures/') && key.endsWith('/session.json'))
				await barrier('artifact-before');
			if (key === nb.source) await barrier('publication-before');
			const result = await put(key, value, options);
			if (key.includes('/captures/') && key.endsWith('/session.json'))
				await barrier('artifact-after');
			if (key === nb.source) await barrier('publication-after');
			return result;
		};
		await capture(session, 'latest');
	}
	const head = await services.notebooks.beginSessionCapture(
		session.project_id,
		session.notebook_id,
	);
	const version = head.versions.find((item) => item.version_id === head.source.current_version_id)!;
	const stored = nb.version(version.version_id);
	const output = await bucket.get(stored.capture(version.session_snapshot!.capture_id!).session);
	const deps = await bucket.get(stored.deps);
	session = await services.sessions.getSession(session.project_id, session.session_id);
	return {
		code: await services.notebooks.getNotebookContent(session.project_id, session.notebook_id),
		deps: await deps!.text(),
		outputs: JSON.parse(await output!.text()),
		versionId: version.version_id,
		receipt: session.last_durable_capture,
		dirty: !!session.save_dirty,
	};
}

void main().then(
	(result) => {
		process.send!({ result });
		process.disconnect!();
	},
	(error: unknown) => {
		console.error(error);
		process.exitCode = 1;
		process.disconnect!();
	},
);
