import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
	BadRequestError,
	DataQueryUserError,
	noopMetrics,
	UnavailableError,
	ValidationError,
} from '@marimo-hub/core';
import type {
	BrowseNamespacesRequest,
	BrowsePage,
	BrowsePageRequest,
	DatabaseBrowser,
	DataQueryExecution,
	DataQueryExecutorFactory,
	DataQueryResult,
	Metrics,
	PostgresConnectionCapability,
	TablePreview,
	TablePreviewRequest,
	TableSchema,
} from '@marimo-hub/core';
import type {
	PinnedAddress,
	PostgresFailureCode,
	PostgresOperation,
	PostgresWorkerFailure,
	PostgresWorkerRequest,
	PostgresWorkerResponse,
	PostgresWorkerValue,
} from './protocol';

export type PostgresHostResolver = (
	hostname: string,
	signal?: AbortSignal,
) => Promise<PinnedAddress[]>;

export interface PostgresRuntimeOptions {
	resolveHost: PostgresHostResolver;
	mode: 'metadata' | 'full';
	metadataTimeoutMs: number;
	previewTimeoutMs: number;
	previewMaxBytes: number;
	metrics?: Metrics;
}

const WORKER_LIMITS = Object.freeze({
	maxOldGenerationSizeMb: 64,
	maxYoungGenerationSizeMb: 16,
	stackSizeMb: 4,
});

export class PostgresDatabaseBrowser implements DatabaseBrowser {
	readonly provider = 'postgres' as const;
	readonly preview: boolean;
	private readonly metrics: Metrics;

	constructor(private readonly options: PostgresRuntimeOptions) {
		this.preview = options.mode === 'full';
		this.metrics = options.metrics ?? noopMetrics;
	}

	async listNamespaces(
		source: PostgresConnectionCapability,
		request: BrowseNamespacesRequest,
	): Promise<BrowsePage<string[]>> {
		if (request.parent !== undefined && request.parent.length > 0) {
			return { items: [], next_cursor: null };
		}
		return this.run<BrowsePage<string[]>>(
			source,
			{ type: 'namespaces', after: decodeNameCursor(request.cursor), limit: request.limit },
			'metadata',
			request.signal,
		);
	}

	async listTables(
		source: PostgresConnectionCapability,
		namespace: string[],
		request: BrowsePageRequest,
	): Promise<BrowsePage<string>> {
		return this.run<BrowsePage<string>>(
			source,
			{
				type: 'tables',
				schema: oneNamespace(namespace),
				after: decodeNameCursor(request.cursor),
				limit: request.limit,
			},
			'metadata',
			request.signal,
		);
	}

	getTableSchema(
		source: PostgresConnectionCapability,
		namespace: string[],
		table: string,
		request?: Pick<TablePreviewRequest, 'signal'>,
	): Promise<TableSchema> {
		return this.run<TableSchema>(
			source,
			{ type: 'schema', schema: oneNamespace(namespace), table },
			'metadata',
			request?.signal,
		);
	}

	previewRows(
		source: PostgresConnectionCapability,
		namespace: string[],
		table: string,
		request: TablePreviewRequest,
	): Promise<TablePreview> {
		if (!this.preview) throw new ValidationError('Row preview requires full data-browser mode.');
		return this.run<TablePreview>(
			source,
			{
				type: 'preview',
				schema: oneNamespace(namespace),
				table,
				limit: request.limit,
				maxBytes: this.options.previewMaxBytes,
			},
			'preview',
			request.signal,
		);
	}

	private async run<T extends PostgresWorkerValue>(
		source: PostgresConnectionCapability,
		operation: PostgresOperation,
		kind: 'metadata' | 'preview',
		signal?: AbortSignal,
	): Promise<T> {
		const started = performance.now();
		const deadline = started + this.timeoutMs(kind);
		let outcome = 'success';
		try {
			const pinned = await resolvePinned(this.options.resolveHost, source.host, signal);
			const timeoutMs = remainingTimeoutMs(deadline);
			return await runWorker<T>({ connection: source, pinned, operation }, timeoutMs, signal);
		} catch (error) {
			outcome = failureOutcome(error);
			throw error;
		} finally {
			this.metrics.increment('postgres_runtime.operation', 1, { operation: kind, outcome });
			this.metrics.histogram?.('postgres_runtime.duration_ms', performance.now() - started, {
				operation: kind,
				outcome,
			});
		}
	}

	private timeoutMs(kind: 'metadata' | 'preview'): number {
		return kind === 'metadata' ? this.options.metadataTimeoutMs : this.options.previewTimeoutMs;
	}
}

export function createPostgresDataQueryExecutorFactory(options: {
	resolveHost: PostgresHostResolver;
	metrics?: Metrics;
}): DataQueryExecutorFactory {
	return {
		async create(signal) {
			if (signal.aborted) throw aborted();
			let stopActive: (() => void) | undefined;
			return {
				runtime: 'worker',
				async execute(request: DataQueryExecution, executionSignal: AbortSignal) {
					const plan = request.connection.plan;
					if (plan?.engine !== 'postgres') {
						throw new ValidationError('The PostgreSQL runtime received an invalid query plan.');
					}
					const started = performance.now();
					const deadline = started + request.limits.deadlineMs;
					let outcome = 'success';
					try {
						const pinned = await resolvePinned(
							options.resolveHost,
							plan.connection.host,
							executionSignal,
						);
						const timeoutMs = remainingTimeoutMs(deadline);
						const result = await runWorker<DataQueryResult>(
							{
								connection: plan.connection,
								pinned,
								operation: {
									type: 'query',
									sql: request.sql,
									maxRows: request.limits.maxRows,
									maxBytes: request.limits.maxBytes,
									deadlineMs: timeoutMs,
								},
							},
							timeoutMs,
							executionSignal,
							(worker) => {
								stopActive = () => stopWorker(worker);
							},
						);
						return result;
					} catch (error) {
						outcome = failureOutcome(error);
						throw error;
					} finally {
						stopActive = undefined;
						const metrics = options.metrics ?? noopMetrics;
						metrics.increment('postgres_runtime.operation', 1, {
							operation: 'query',
							outcome,
						});
						metrics.histogram?.('postgres_runtime.duration_ms', performance.now() - started, {
							operation: 'query',
							outcome,
						});
					}
				},
				terminate() {
					stopActive?.();
				},
			};
		},
	};
}

async function runWorker<T extends PostgresWorkerValue>(
	input: Omit<PostgresWorkerRequest, 'id'>,
	timeoutMs: number,
	signal?: AbortSignal,
	onWorker?: (worker: Worker) => void,
): Promise<T> {
	if (signal?.aborted) throw aborted();
	const worker = new Worker(resolveWorkerUrl(), { resourceLimits: WORKER_LIMITS, env: {} });
	onWorker?.(worker);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error, value?: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			if (error?.name === 'AbortError' || error?.message.includes('timed out')) stopWorker(worker);
			else void worker.terminate();
			if (error) reject(error);
			else resolve(value!);
		};
		const onAbort = () => finish(aborted());
		const timer = setTimeout(
			() => finish(new UnavailableError('The PostgreSQL request timed out.')),
			timeoutMs,
		);
		signal?.addEventListener('abort', onAbort, { once: true });
		worker.once('error', () => finish(mappedFailure('worker_failure')));
		worker.once('exit', (code) => {
			if (!settled && code !== 0) finish(mappedFailure('worker_failure'));
		});
		worker.on('message', (message: PostgresWorkerResponse) => {
			if (message.id !== 1) return;
			if (!message.ok) finish(mappedFailure(message));
			else finish(undefined, message.value as T);
		});
		worker.postMessage({ ...input, id: 1 } satisfies PostgresWorkerRequest);
	});
}

function stopWorker(worker: Worker): void {
	try {
		worker.postMessage({ type: 'terminate' });
	} catch {}
	setTimeout(() => void worker.terminate(), 500).unref();
}

function oneNamespace(namespace: string[]): string {
	if (namespace.length !== 1 || namespace[0] === '') {
		throw new ValidationError('PostgreSQL relations require one schema namespace.');
	}
	return namespace[0];
}

async function resolvePinned(
	resolveHost: PostgresHostResolver,
	host: string,
	signal?: AbortSignal,
): Promise<PinnedAddress[]> {
	try {
		const pinned = await resolveHost(host, signal);
		if (
			pinned.length === 0 ||
			pinned.some(
				(address) =>
					typeof address.address !== 'string' ||
					(address.family !== 4 && address.family !== 6) ||
					isIP(address.address) !== address.family,
			)
		) {
			throw new Error('Invalid pinned address.');
		}
		return pinned;
	} catch (error) {
		if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw aborted();
		throw new UnavailableError('The PostgreSQL target is not permitted.');
	}
}

function decodeNameCursor(cursor: string | undefined): string | undefined {
	if (cursor === undefined) return undefined;
	if (!cursor.startsWith('name:')) throw new BadRequestError('Invalid browse cursor.');
	try {
		const decoded = decodeURIComponent(cursor.slice(5));
		if (decoded === '') throw new Error('Empty cursor.');
		return decoded;
	} catch {
		throw new BadRequestError('Invalid browse cursor.');
	}
}

function mappedFailure(failure: PostgresWorkerFailure | PostgresFailureCode): Error {
	const details = typeof failure === 'string' ? { code: failure } : failure;
	const { code } = details;
	if (code === 'query_rejected') {
		const location =
			details.sqlState === undefined
				? ''
				: ` (SQLSTATE ${details.sqlState}${details.position === undefined ? '' : ` at character ${details.position}`})`;
		return new DataQueryUserError(`PostgreSQL rejected this read-only query${location}.`);
	}
	const messages: Record<Exclude<PostgresFailureCode, 'query_rejected'>, string> = {
		target_denied: 'The PostgreSQL target is not permitted.',
		authentication: 'PostgreSQL authentication failed.',
		tls: 'The PostgreSQL TLS connection failed.',
		connection: 'The PostgreSQL connection failed.',
		timeout: 'The PostgreSQL request timed out.',
		malformed_result: 'PostgreSQL returned an invalid result.',
		worker_failure: 'The PostgreSQL worker failed.',
	};
	return new UnavailableError(messages[code]);
}

function failureOutcome(error: unknown): string {
	if (error instanceof ValidationError) return 'rejected';
	if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
	return 'failed';
}

function aborted(): Error {
	const error = new UnavailableError('The PostgreSQL request was cancelled.');
	error.name = 'AbortError';
	return error;
}

function remainingTimeoutMs(deadline: number): number {
	const remaining = Math.floor(deadline - performance.now());
	if (remaining < 1) throw new UnavailableError('The PostgreSQL request timed out.');
	return remaining;
}

function resolveWorkerUrl(): URL {
	if (import.meta.url.endsWith('.ts')) return new URL('./worker.ts', import.meta.url);
	for (const candidate of ['./postgresWorker.mjs', './worker.mjs']) {
		const url = new URL(candidate, import.meta.url);
		if (existsSync(fileURLToPath(url))) return url;
	}
	throw new Error('PostgreSQL worker file not found next to the runtime module.');
}
