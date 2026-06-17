import type { Bucket } from '../ports/bucket';
import { UnavailableError } from '../errors';
import type { NotebookId, ProjectId, SandboxId } from '../ids';
import { paths } from '../paths';
import type { SandboxInstance, SandboxProvider } from '../ports/sandbox';
import { loadNotebookFiles, saveNotebookFiles } from './sandboxFiles';

const MARIMO_PORT = 2718;
const MOUNT_PATH = '/workspace/notebooks';

export interface BucketConfig {
	name: string;
	endpoint: string;
	credentials?: {
		accessKeyId: string;
		secretAccessKey: string;
	};
}

export interface ProvisionOptions {
	sandboxId: SandboxId;
	projectId: ProjectId;
	notebookId: NotebookId;
	hostname: string;
	bucket: BucketConfig;
	/** R2 Bucket handle for fallback file copy */
	bucketHandle?: Bucket;
}

export interface ProvisionResult {
	sandbox: SandboxInstance;
	url: string;
	/** Whether files were loaded via manual copy (true) or bucket mount (false) */
	usedFallback: boolean;
}

export class SandboxProvisioner {
	constructor(private provider: SandboxProvider) {}

	async provision(options: ProvisionOptions): Promise<ProvisionResult> {
		const sandbox = this.provider.create(options.sandboxId);
		const nb = paths.project(options.projectId).notebook(options.notebookId);

		// 0. Verify the sandbox container is reachable
		try {
			await sandbox.exec('true');
		} catch (err) {
			throw new UnavailableError(
				`Sandbox container is not available. Is Docker running? ` +
					`(${err instanceof Error ? err.message : String(err)})`,
			);
		}

		// 1. Try to mount the R2 bucket; fall back to manual file copy
		let usedFallback = false;
		try {
			await sandbox.mountBucket({
				bucketName: options.bucket.name,
				endpoint: options.bucket.endpoint,
				mountPath: MOUNT_PATH,
				prefix: nb.prefix,
				credentials: options.bucket.credentials,
			});
		} catch {
			usedFallback = true;
			if (options.bucketHandle) {
				await loadNotebookFiles(
					sandbox,
					options.bucketHandle,
					options.projectId,
					options.notebookId,
				);
			}
		}

		// 2. Start marimo
		const process = await sandbox.startProcess(
			`uv run marimo edit ${MOUNT_PATH}/notebook.py --headless --no-token --port ${MARIMO_PORT}`,
			{ cwd: '/workspace' },
		);
		await process.waitForPort(MARIMO_PORT);

		// 3. Expose the port and return the URL
		const { url } = await sandbox.exposePort(MARIMO_PORT, {
			hostname: options.hostname,
			token: options.sandboxId,
		});

		return { sandbox, url, usedFallback };
	}

	/**
	 * Save files back to the bucket (if fallback was used) and destroy the sandbox.
	 */
	async teardown(
		sandbox: SandboxInstance,
		bucket: Bucket,
		projectId: ProjectId,
		notebookId: NotebookId,
		usedFallback: boolean,
	): Promise<void> {
		if (usedFallback) {
			await saveNotebookFiles(sandbox, bucket, projectId, notebookId);
		}
		await sandbox.destroy();
	}
}
