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

	async query(
		userId: UserId,
		input: DataQueryInput,
		signal?: AbortSignal,
	): Promise<DataQueryResult> {
		if (this.closed) throw new UnavailableError('The data-query service is closed.');
		assertValidDataQuerySql(input.sql);
		return this.inFlight.track(this.admission.run(userId, () => this.execute(input, signal)));
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

	private async execute(
		input: DataQueryInput,
		externalSignal?: AbortSignal,
	): Promise<DataQueryResult> {
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
		const onAbort = () => active.stop(new UnavailableError('The data query was cancelled.'));
		externalSignal?.addEventListener('abort', onAbort, { once: true });
		if (externalSignal?.aborted) onAbort();
		const timer = setTimeout(
			() => active.stop(new UnavailableError('The data query timed out.')),
			this.options.executionTimeoutMs,
		);
		try {
			const started = performance.now();
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
				return this.validateResult({
					...result,
					execution_ms: Math.max(0, Math.round(performance.now() - started)),
				});
			})();
			return await Promise.race([work, stopped]);
		} catch (error) {
			if (error === stopError) throw error;
			throw new UnavailableError('The data-query runtime could not execute this query.');
		} finally {
			clearTimeout(timer);
			externalSignal?.removeEventListener('abort', onAbort);
			controller.abort();
			terminate();
			this.active.delete(active);
		}
	}

	private validateResult(result: DataQueryResult): DataQueryResult {
		if (
			!Array.isArray(result.columns) ||
			!result.columns.every((column) => typeof column === 'string') ||
			!Array.isArray(result.rows) ||
			result.rows.length > this.options.maxRows ||
			!result.rows.every((row) => Array.isArray(row) && row.length === result.columns.length) ||
			typeof result.truncated !== 'boolean' ||
			typeof result.execution_ms !== 'number' ||
			!Number.isSafeInteger(result.execution_ms) ||
			result.execution_ms < 0
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

export function assertValidDataQuerySql(sql: string): void {
	if (sql.trim().length === 0) throw new ValidationError('SQL must not be empty.');
	if (new TextEncoder().encode(sql).byteLength > MAX_DATA_QUERY_SQL_BYTES) {
		throw new ValidationError(`SQL exceeds the ${MAX_DATA_QUERY_SQL_BYTES}-byte limit.`);
	}
	singleDataQueryStatement(sql);
}

export function singleDataQueryStatement(sql: string): string {
	const statements: string[] = [];
	let start = 0;
	let hasToken = false;
	let mode: 'normal' | 'single' | 'double' | 'backtick' | 'line-comment' | 'block-comment' =
		'normal';
	let blockDepth = 0;
	let dollarDelimiter: string | undefined;

	for (let index = 0; index < sql.length; index++) {
		const character = sql[index];
		const next = sql[index + 1];
		if (dollarDelimiter !== undefined) {
			if (sql.startsWith(dollarDelimiter, index)) {
				index += dollarDelimiter.length - 1;
				dollarDelimiter = undefined;
			}
			continue;
		}
		if (mode === 'line-comment') {
			if (character === '\n' || character === '\r') mode = 'normal';
			continue;
		}
		if (mode === 'block-comment') {
			if (character === '/' && next === '*') {
				blockDepth++;
				index++;
			} else if (character === '*' && next === '/') {
				blockDepth--;
				index++;
				if (blockDepth === 0) mode = 'normal';
			}
			continue;
		}
		if (mode !== 'normal') {
			const quote = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
			if (character === quote) {
				if (next === quote) index++;
				else mode = 'normal';
			}
			continue;
		}

		if (character === '-' && next === '-') {
			mode = 'line-comment';
			index++;
			continue;
		}
		if (character === '/' && next === '*') {
			mode = 'block-comment';
			blockDepth = 1;
			index++;
			continue;
		}
		if (character === "'" || character === '"' || character === '`') {
			hasToken = true;
			mode = character === "'" ? 'single' : character === '"' ? 'double' : 'backtick';
			continue;
		}
		if (character === '$') {
			const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
			if (delimiter !== undefined) {
				hasToken = true;
				dollarDelimiter = delimiter;
				index += delimiter.length - 1;
				continue;
			}
		}
		if (character === ';') {
			if (hasToken) statements.push(sql.slice(start, index).trim());
			start = index + 1;
			hasToken = false;
			continue;
		}
		if (!/\s/.test(character)) hasToken = true;
	}
	if (hasToken) statements.push(sql.slice(start).trim());
	if (statements.length !== 1) {
		throw new ValidationError('SQL must contain exactly one statement.');
	}
	return statements[0];
}
