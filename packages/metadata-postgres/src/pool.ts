import { Pool } from 'pg';

export interface PostgresConnectionOptions {
	url: string;
	poolMax?: number;
	connectTimeoutMs?: number;
	statementTimeoutMs?: number;
	lockTimeoutMs?: number;
}

export function createMetadataPool(options: PostgresConnectionOptions): Pool {
	const max = options.poolMax ?? 10;
	const connectionTimeoutMillis = options.connectTimeoutMs ?? 5000;
	const statement_timeout = options.statementTimeoutMs ?? 10000;
	const lock_timeout = options.lockTimeoutMs ?? 2000;
	for (const value of [max, connectionTimeoutMillis, statement_timeout, lock_timeout]) {
		if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
			throw new RangeError('Invalid PostgreSQL pool limit or timeout');
	}
	if (lock_timeout > statement_timeout)
		throw new RangeError('Lock timeout must not exceed statement timeout');
	const pool = new Pool({
		connectionString: options.url,
		max,
		connectionTimeoutMillis,
		statement_timeout,
		lock_timeout,
		idle_in_transaction_session_timeout: 15000,
	});
	// Idle connection failures must not become uncaught process errors. Active queries reject.
	pool.on('error', () => {});
	// Checked-out clients can emit a disconnect error after their query rejects.
	pool.on('connect', (client) => client.on('error', () => {}));
	return pool;
}
