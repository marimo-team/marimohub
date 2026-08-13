import { InFlightWork, KeyedAdmission } from '../../../concurrency';
import { ResourceExhaustedError, UnavailableError, ValidationError } from '../../../errors';
import type { UserId } from '../../../ids';
import { assertPositiveIntegers } from '../../../internal/validation';
import type {
	DataQueryConnection,
	DataQueryExecutorFactory,
	DataQueryResult,
	DisposableDataQueryExecutor,
} from './contracts';

export const MAX_DATA_QUERY_SQL_BYTES = 32 * 1024;

export interface DataQueryServiceOptions {
	executorFactory: DataQueryExecutorFactory;
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

export class DataQueryService {
	private readonly admission: KeyedAdmission<UserId>;
	private readonly inFlight = new InFlightWork();
	private readonly active = new Set<ActiveQuery>();
	private closed = false;
	private closing: Promise<void> | undefined;

	constructor(private readonly options: DataQueryServiceOptions) {
		assertPositiveIntegers({
			maxConcurrent: options.maxConcurrent,
			maxConcurrentPerUser: options.maxConcurrentPerUser,
			maxRows: options.maxRows,
			maxBytes: options.maxBytes,
			executionTimeoutMs: options.executionTimeoutMs,
		});
		this.admission = new KeyedAdmission(options.maxConcurrent, options.maxConcurrentPerUser, {
			global: () =>
				new ResourceExhaustedError('The deployment data-query limit is currently full.'),
			perKey: () => new ResourceExhaustedError('A data query is already running for this user.'),
		});
	}

	async query(userId: UserId, input: DataQueryInput): Promise<DataQueryResult> {
		if (this.closed) throw new UnavailableError('The data-query service is closed.');
		this.validateSql(input.sql);
		return this.inFlight.track(this.admission.run(userId, () => this.execute(input)));
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		for (const query of this.active) {
			query.stop(new UnavailableError('The data-query service is closed.'));
		}
		this.closing = this.inFlight.drain();
		return this.closing;
	}

	private async execute(input: DataQueryInput): Promise<DataQueryResult> {
		const controller = new AbortController();
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
		const timer = setTimeout(
			() => active.stop(new UnavailableError('The data query timed out.')),
			this.options.executionTimeoutMs,
		);
		try {
			const work = (async () => {
				executor = await this.options.executorFactory.create(controller.signal);
				if (controller.signal.aborted) {
					terminate();
					throw new UnavailableError('The data query was cancelled.');
				}
				if (executor.runtime !== 'worker' && executor.runtime !== 'process') {
					throw new UnavailableError('The data-query executor is not isolated.');
				}
				const result = await executor.execute(
					{
						sql: input.sql,
						connection: input.connection,
						accessMode: 'read-only',
						limits: {
							maxRows: this.options.maxRows,
							maxBytes: this.options.maxBytes,
							deadlineMs: this.options.executionTimeoutMs,
						},
					},
					controller.signal,
				);
				return this.validateResult(result);
			})();
			return await Promise.race([work, stopped]);
		} catch (error) {
			if (error === stopError) throw error;
			throw new UnavailableError('The data-query runtime could not execute this query.');
		} finally {
			clearTimeout(timer);
			controller.abort();
			terminate();
			this.active.delete(active);
		}
	}

	private validateSql(sql: string): void {
		if (sql.trim().length === 0) throw new ValidationError('SQL must not be empty.');
		if (new TextEncoder().encode(sql).byteLength > MAX_DATA_QUERY_SQL_BYTES) {
			throw new ValidationError(`SQL exceeds the ${MAX_DATA_QUERY_SQL_BYTES}-byte limit.`);
		}
	}

	private validateResult(result: DataQueryResult): DataQueryResult {
		if (
			!Array.isArray(result.columns) ||
			!result.columns.every((column) => typeof column === 'string') ||
			!Array.isArray(result.rows) ||
			result.rows.length > this.options.maxRows ||
			!result.rows.every((row) => Array.isArray(row) && row.length === result.columns.length) ||
			typeof result.truncated !== 'boolean'
		) {
			throw new UnavailableError('The data-query runtime returned an invalid result.');
		}
		let bytes: number;
		try {
			bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
		} catch {
			throw new UnavailableError('The data-query runtime returned an invalid result.');
		}
		if (bytes > this.options.maxBytes) {
			throw new UnavailableError('The data-query result exceeded its byte limit.');
		}
		return result;
	}
}
