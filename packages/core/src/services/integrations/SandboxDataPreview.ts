import { ResourceExhaustedError, UnavailableError } from '../../errors';
import { createSandboxId } from '../../ids';
import { logOperationalError } from '../../operationalLog';
import type { DataPreview, DataPreviewRequest, TablePreview } from '../../ports/integrations';
import type { SandboxInstance, SandboxProvider } from '../../ports/sandbox';

const SCRIPT_PATH = '/tmp/marimohub-data-preview.py';
const REQUEST_PATH = '/tmp/marimohub-data-preview-request.json';
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const PREFLIGHT_COMMAND = `python3 -c 'import pyarrow, pyiceberg'`;

const PREVIEW_SCRIPT = `import json
from pyiceberg.catalog import load_catalog

with open(${JSON.stringify(REQUEST_PATH)}, encoding="utf-8") as request_file:
    request = json.load(request_file)

catalog = load_catalog(request["integration_name"])
identifier = tuple([*request["namespace"], request["table"]])
arrow = catalog.load_table(identifier).scan(limit=request["limit"]).to_arrow()
columns = [str(field.name) for field in arrow.schema]
rows = [[record.get(column) for column in columns] for record in arrow.to_pylist()]
print(json.dumps({"columns": columns, "rows": rows}, default=str, separators=(",", ":")))
`;

export interface SandboxDataPreviewOptions {
	image: string;
	maxConcurrent: number;
	maxConcurrentPerUser: number;
	startupTimeoutMs: number;
	executionTimeoutMs: number;
	destroyTimeoutMs?: number;
}

export class SandboxDataPreview implements DataPreview {
	private readyForTraffic = false;
	private checking: Promise<void> | undefined;
	private active = 0;
	private readonly activeByUser = new Map<string, number>();

	constructor(
		private readonly compute: SandboxProvider,
		private readonly options: SandboxDataPreviewOptions,
	) {
		for (const [name, value] of [
			['maxConcurrent', options.maxConcurrent],
			['maxConcurrentPerUser', options.maxConcurrentPerUser],
			['startupTimeoutMs', options.startupTimeoutMs],
			['executionTimeoutMs', options.executionTimeoutMs],
		] as const) {
			if (!Number.isInteger(value) || value < 1)
				throw new Error(`${name} must be a positive integer`);
		}
	}

	get preflightTimeoutMs(): number {
		return (
			this.options.startupTimeoutMs +
			this.options.executionTimeoutMs +
			(this.options.destroyTimeoutMs ?? this.options.executionTimeoutMs) +
			1000
		);
	}

	available(): boolean {
		return this.readyForTraffic;
	}

	check(): Promise<void> {
		if (this.readyForTraffic) return Promise.resolve();
		if (this.checking) return this.checking;
		this.checking = this.checkRuntime().finally(() => {
			this.checking = undefined;
		});
		return this.checking;
	}

	private async checkRuntime(): Promise<void> {
		if (this.active >= this.options.maxConcurrent) {
			throw new ResourceExhaustedError('The deployment data-preview limit is currently full.');
		}
		this.active++;
		let sandbox: SandboxInstance | undefined;
		try {
			sandbox = this.createSandbox();
			await withDeadline(ready(sandbox), this.options.startupTimeoutMs, 'start');
			const result = await withDeadline(
				sandbox.exec(PREFLIGHT_COMMAND),
				this.options.executionTimeoutMs,
				'verify its runtime',
			);
			if (!result.success) {
				throw new UnavailableError('The preview image does not provide PyIceberg and PyArrow.');
			}
			this.readyForTraffic = true;
		} finally {
			if (sandbox) await this.destroy(sandbox);
			this.active--;
		}
	}

	async preview(request: DataPreviewRequest): Promise<TablePreview> {
		if (!this.readyForTraffic) {
			throw new UnavailableError('The data-preview runtime is unavailable.');
		}
		return this.withPermit(request.user_id, async () => {
			const sandbox = this.createSandbox();
			try {
				await withDeadline(ready(sandbox), this.options.startupTimeoutMs, 'start');
				await withDeadline(
					Promise.all([
						sandbox.writeFiles([
							...request.bundle.files,
							{ path: SCRIPT_PATH, content: PREVIEW_SCRIPT },
							{
								path: REQUEST_PATH,
								content: JSON.stringify({
									integration_name: request.integration_name,
									namespace: request.namespace,
									table: request.table,
									limit: request.limit,
								}),
							},
						]),
						sandbox.setEnvVars({ ...request.bundle.vars, ...request.credential_vars }),
					]),
					this.options.startupTimeoutMs,
					'prepare',
				);
				const result = await withDeadline(
					sandbox.exec(`python3 ${SCRIPT_PATH}`),
					this.options.executionTimeoutMs,
					'finish',
				);
				if (
					!result.success ||
					new TextEncoder().encode(result.stdout).byteLength > MAX_STDOUT_BYTES
				) {
					throw new UnavailableError('The preview sandbox could not read this table.');
				}
				return parsePreview(result.stdout, request.limit);
			} finally {
				await this.destroy(sandbox);
			}
		});
	}

	private createSandbox(): SandboxInstance {
		return this.compute.create(createSandboxId(), {
			reuse: false,
			image: this.options.image,
		});
	}

	private async withPermit<T>(userId: string, run: () => Promise<T>): Promise<T> {
		const userActive = this.activeByUser.get(userId) ?? 0;
		if (userActive >= this.options.maxConcurrentPerUser) {
			throw new ResourceExhaustedError('A data preview is already running for this user.');
		}
		if (this.active >= this.options.maxConcurrent) {
			throw new ResourceExhaustedError('The deployment data-preview limit is currently full.');
		}
		this.active++;
		this.activeByUser.set(userId, userActive + 1);
		try {
			return await run();
		} finally {
			this.active--;
			const remaining = (this.activeByUser.get(userId) ?? 1) - 1;
			if (remaining === 0) this.activeByUser.delete(userId);
			else this.activeByUser.set(userId, remaining);
		}
	}

	private async destroy(sandbox: SandboxInstance): Promise<void> {
		try {
			await withDeadline(
				sandbox.destroy(),
				this.options.destroyTimeoutMs ?? this.options.executionTimeoutMs,
				'destroy',
			);
		} catch (error) {
			logOperationalError('data_preview_sandbox_destroy_failed', {}, error);
		}
	}
}

async function ready(sandbox: SandboxInstance): Promise<void> {
	if (sandbox.ready) return sandbox.ready();
	const result = await sandbox.exec('true');
	if (!result.success) throw new UnavailableError('The preview sandbox could not start.');
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new UnavailableError(`The preview sandbox did not ${phase} in time.`)),
			timeoutMs,
		);
	});
	return Promise.race([work, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function parsePreview(stdout: string, limit: number): TablePreview {
	let value: unknown;
	try {
		value = JSON.parse(stdout.trim());
	} catch {
		throw new UnavailableError('The preview sandbox returned an invalid result.');
	}
	if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) {
		throw new UnavailableError('The preview sandbox returned an invalid result.');
	}
	if (!value.columns.every((column) => typeof column === 'string')) {
		throw new UnavailableError('The preview sandbox returned an invalid result.');
	}
	const columns = value.columns;
	if (value.rows.length > limit) {
		throw new UnavailableError('The preview sandbox returned an invalid result.');
	}
	const rows = value.rows;
	if (!rows.every((row): row is unknown[] => Array.isArray(row) && row.length === columns.length)) {
		throw new UnavailableError('The preview sandbox returned an invalid result.');
	}
	return { columns, rows };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
