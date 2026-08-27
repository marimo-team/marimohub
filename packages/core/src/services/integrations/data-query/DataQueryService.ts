import { KeyedAdmission } from '../../../concurrency';
import { MAX_TIMER_DELAY_MS } from '../../../async';
import { ResourceExhaustedError, UnavailableError, ValidationError } from '../../../errors';
import type { UserId } from '../../../ids';
import { assertPositiveIntegers } from '../../../internal/validation';
import type {
	DataQueryConnection,
	DataQueryEngine,
	DataQueryExecutorFactory,
	DataQueryResult,
	DisposableDataQueryExecutor,
} from './contracts';
import { DataQueryUserError } from './contracts';
import { redactConnectionSecrets } from './redaction';
import { validateTableData } from '../data-preview/previewResult';
import { DrainableService } from '../DrainableService';
import { singleDataQueryStatement } from './sql';

export const MAX_DATA_QUERY_SQL_BYTES = 32 * 1024;

export interface DataQueryServiceOptions {
	executorFactories?: Readonly<Partial<Record<DataQueryEngine, DataQueryExecutorFactory>>>;
	/** Compatibility input for embedders that only install DuckDB-Wasm. */
	executorFactory?: DataQueryExecutorFactory;
	maxConcurrent: number;
	maxConcurrentPerUser: number;
	maxRows: number;
	maxBytes: number;
	executionTimeoutMs: number;
}

export interface DataQueryInput {
	sql: string;
	connection: DataQueryConnection;
}

interface ActiveQuery {
	stop(error: UnavailableError): void;
}

export class DataQueryService extends DrainableService {
	private readonly admission: KeyedAdmission<UserId>;
	private readonly active = new Set<ActiveQuery>();

	constructor(private readonly options: DataQueryServiceOptions) {
		super();
		assertPositiveIntegers({
			maxConcurrent: options.maxConcurrent,
			maxConcurrentPerUser: options.maxConcurrentPerUser,
			maxRows: options.maxRows,
			maxBytes: options.maxBytes,
			executionTimeoutMs: options.executionTimeoutMs,
		});
		if (options.executionTimeoutMs > MAX_TIMER_DELAY_MS) {
			throw new RangeError(`executionTimeoutMs must be <= ${MAX_TIMER_DELAY_MS}`);
		}
		this.admission = new KeyedAdmission(options.maxConcurrent, options.maxConcurrentPerUser, {
			global: () =>
				new ResourceExhaustedError('The deployment data-query limit is currently full.'),
			perKey: () => new ResourceExhaustedError('A data query is already running for this user.'),
		});
	}

	supports(engine: DataQueryEngine): boolean {
		return this.factoryFor(engine) !== undefined;
	}

	private factoryFor(engine: DataQueryEngine): DataQueryExecutorFactory | undefined {
		return (
			this.options.executorFactories?.[engine] ??
			(engine === 'duckdb-wasm' ? this.options.executorFactory : undefined)
		);
	}

	async query(
		userId: UserId,
		input: DataQueryInput,
		signal?: AbortSignal,
	): Promise<DataQueryResult> {
		if (this.closed) throw new UnavailableError('The data-query service is closed.');
		assertValidDataQuerySql(input.sql, input.connection.integration.kind);
		return this.track(this.admission.run(userId, () => this.execute(input, signal)));
	}

	close(): Promise<void> {
		return this.closeOnce(async () => {
			for (const query of this.active) {
				query.stop(new UnavailableError('The data-query service is closed.'));
			}
			await this.inFlight.drain();
		});
	}

	private async execute(
		input: DataQueryInput,
		externalSignal?: AbortSignal,
	): Promise<DataQueryResult> {
		const controller = new AbortController();
		const deadlineAtMs = Date.now() + this.options.executionTimeoutMs;
		let executor: DisposableDataQueryExecutor | undefined;
		let terminated = false;
		let rejectStop!: (error: UnavailableError) => void;
		let stopError: UnavailableError | undefined;
		const stopped = new Promise<never>((_resolve, reject) => {
			rejectStop = reject;
		});
		const terminate = () => {
			if (terminated || !executor) return;
			terminated = true;
			try {
				executor.terminate();
			} catch {
				// The query is already unusable; teardown errors must not defeat the deadline.
			}
		};
		let stoppedAlready = false;
		const active: ActiveQuery = {
			stop: (error) => {
				if (stoppedAlready) return;
				stoppedAlready = true;
				stopError = error;
				controller.abort();
				terminate();
				rejectStop(error);
			},
		};
		this.active.add(active);
		const onAbort = () => active.stop(new UnavailableError('The data query was cancelled.'));
		externalSignal?.addEventListener('abort', onAbort, { once: true });
		if (externalSignal?.aborted) onAbort();
		const timer = setTimeout(
			() => active.stop(new UnavailableError('The data query timed out.')),
			this.options.executionTimeoutMs,
		);
		// Executor rejections may quote connection secrets; classify and redact
		// them at the boundary. The service's own errors are fixed safe strings.
		const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
			try {
				return await operation();
			} catch (error) {
				throw toSafeExecutorError(error, input.connection);
			}
		};
		try {
			const started = performance.now();
			const work = (async () => {
				const engine = input.connection.plan?.engine ?? 'duckdb-wasm';
				const factory = this.factoryFor(engine);
				if (!factory)
					throw new UnavailableError('The requested data-query engine is not installed.');
				const created = await guarded(() => factory.create(controller.signal));
				executor = created;
				if (controller.signal.aborted) {
					terminate();
					throw new UnavailableError('The data query was cancelled.');
				}
				if (created.runtime !== 'worker' && created.runtime !== 'process') {
					throw new UnavailableError('The data-query executor is not isolated.');
				}
				const result = await guarded(() =>
					created.execute(
						{
							sql: input.sql,
							connection: input.connection,
							accessMode: 'read-only',
							limits: {
								maxRows: this.options.maxRows,
								maxBytes: this.options.maxBytes,
								deadlineMs: Math.max(1, deadlineAtMs - Date.now()),
							},
						},
						controller.signal,
					),
				);
				return this.validateResult({
					...result,
					execution_ms: Math.max(0, Math.round(performance.now() - started)),
				});
			})();
			return await Promise.race([work, stopped]);
		} catch (error) {
			// A requested stop (cancel/timeout/close) wins over whatever the doomed
			// executor rejected with.
			if (stopError !== undefined) throw stopError;
			throw error;
		} finally {
			clearTimeout(timer);
			externalSignal?.removeEventListener('abort', onAbort);
			controller.abort();
			terminate();
			this.active.delete(active);
		}
	}

	private validateResult(result: DataQueryResult): DataQueryResult {
		const invalid = () =>
			new UnavailableError('The data-query runtime returned an invalid result.');
		const table = validateTableData(result.columns, result.rows, {
			maxRows: this.options.maxRows,
			invalid,
		});
		if (
			typeof result.truncated !== 'boolean' ||
			typeof result.execution_ms !== 'number' ||
			!Number.isSafeInteger(result.execution_ms) ||
			result.execution_ms < 0
		) {
			throw invalid();
		}
		const validated = { ...result, ...table };
		let bytes: number;
		try {
			bytes = new TextEncoder().encode(JSON.stringify(validated)).byteLength;
		} catch {
			throw invalid();
		}
		if (bytes > this.options.maxBytes) {
			throw new UnavailableError('The data-query result exceeded its byte limit.');
		}
		return validated;
	}
}

/**
 * Executor failures may quote credentials the connection injected into the
 * runtime, so only adapter-vetted user-SQL errors surface — redacted — while
 * everything else collapses to a generic message with the redacted detail kept
 * on `cause` for server-side logging.
 */
function toSafeExecutorError(error: unknown, connection: DataQueryConnection): Error {
	const message = redactConnectionSecrets(
		error instanceof Error ? error.message : String(error),
		connection,
	);
	// The name fallback keeps classification working when the adapter holds a
	// bundled copy of the class.
	const isUserError =
		error instanceof DataQueryUserError ||
		(error instanceof Error && error.name === 'DataQueryUserError');
	if (isUserError) return new ValidationError(message);
	return new UnavailableError('The data-query runtime could not execute this query.', {
		cause: new Error(message),
	});
}

export function assertValidDataQuerySql(sql: string, integrationKind?: string): void {
	if (sql.trim().length === 0) throw new ValidationError('SQL must not be empty.');
	if (new TextEncoder().encode(sql).byteLength > MAX_DATA_QUERY_SQL_BYTES) {
		throw new ValidationError(`SQL exceeds the ${MAX_DATA_QUERY_SQL_BYTES}-byte limit.`);
	}
	try {
		singleDataQueryStatement(sql, { backslashEscapes: integrationKind === 'clickhouse' });
	} catch {
		throw new ValidationError('SQL must contain exactly one statement.');
	}
}
