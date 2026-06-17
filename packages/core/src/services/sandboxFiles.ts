import type { Bucket } from '../ports/bucket';
import type { NotebookId, ProjectId } from '../ids';
import { paths } from '../paths';
import type { SandboxInstance } from '../ports/sandbox';

const MOUNT_PATH = '/workspace/notebooks';

/**
 * Load notebook files from the bucket into the sandbox filesystem.
 * Copies notebook.py and pyproject.toml if they exist.
 */
export async function loadNotebookFiles(
	sandbox: SandboxInstance,
	bucket: Bucket,
	projectId: ProjectId,
	notebookId: NotebookId,
): Promise<void> {
	const nb = paths.project(projectId).notebook(notebookId);

	await sandbox.exec(`mkdir -p ${MOUNT_PATH}`);

	const filesToCopy = [
		{ bucketKey: nb.code, sandboxPath: `${MOUNT_PATH}/notebook.py` },
		{ bucketKey: nb.deps, sandboxPath: `${MOUNT_PATH}/pyproject.toml` },
	];

	for (const { bucketKey, sandboxPath } of filesToCopy) {
		const obj = await bucket.get(bucketKey);
		if (obj) {
			const content = await obj.text();
			await sandbox.writeFile(sandboxPath, content);
		}
	}
}

/**
 * Save notebook files from the sandbox back to the bucket.
 * Reads notebook.py and pyproject.toml and writes them back.
 */
export async function saveNotebookFiles(
	sandbox: SandboxInstance,
	bucket: Bucket,
	projectId: ProjectId,
	notebookId: NotebookId,
): Promise<void> {
	const nb = paths.project(projectId).notebook(notebookId);

	const filesToSave = [
		{ sandboxPath: `${MOUNT_PATH}/notebook.py`, bucketKey: nb.code },
		{ sandboxPath: `${MOUNT_PATH}/pyproject.toml`, bucketKey: nb.deps },
	];

	for (const { sandboxPath, bucketKey } of filesToSave) {
		const result = await sandbox.readFile(sandboxPath);
		if (result.success) {
			await bucket.put(bucketKey, result.content);
		}
	}
}
