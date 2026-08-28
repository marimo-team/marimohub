import { connect as netConnect } from 'node:net';
import type { LookupFunction, Socket } from 'node:net';
import { Transform } from 'node:stream';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { parentPort } from 'node:worker_threads';
import pg from 'pg';
import type { Client as PgClient, CustomTypesConfig, FieldDef, QueryResult } from 'pg';
import Cursor from 'pg-cursor';
import type {
	PostgresOperation,
	PostgresWorkerFailure,
	PostgresWorkerRequest,
	PostgresWorkerResponse,
} from './protocol';
import { postgresQuery, PostgresStatementTypeError, QUERY_WRAPPER_PREFIX } from './query.ts';
import { postgresSslOptions, postgresTlsUnavailable } from './tls.ts';

const { Client, Connection } = pg;
const SSL_REQUEST_CODE = 80_877_103;
const CANCEL_REQUEST_CODE = 80_877_102;
const CURSOR_BATCH_ROWS = 1;
// pg-protocol buffers a complete DataRow before pg-cursor can inspect it. These
// caps keep raw frames, parsed values, and the serialized result inside the worker heap.
const MAX_DATA_ROW_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_WORKER_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_DATA_ROW_FRAME_BYTES = 1024 * 1024;

let activeSocket: Socket | undefined;
let activeCancel:
	| {
			host: string;
			port: number;
			lookup: LookupFunction;
			tls: PostgresWorkerRequest['connection']['tls'];
			processId: number;
			secretKey: number;
	  }
	| undefined;

parentPort?.on('message', (message: PostgresWorkerRequest | { type: 'terminate' }) => {
	if ('type' in message) {
		cancelActiveQuery();
		return;
	}
	const request = message;
	void execute(request).then(
		(value) =>
			parentPort?.postMessage({ id: request.id, ok: true, value } satisfies PostgresWorkerResponse),
		(error) =>
			parentPort?.postMessage({
				id: request.id,
				ok: false,
				...classifyFailure(error, request.operation),
			} satisfies PostgresWorkerResponse),
	);
});

async function execute(request: PostgresWorkerRequest) {
	let client: PgClient | undefined;
	try {
		client = await connect(request, request.connection.tls.mode);
		return await runOperation(client, request.operation);
	} catch (error) {
		if (
			request.connection.tls.mode === 'prefer' &&
			client === undefined &&
			postgresTlsUnavailable(error)
		) {
			client = await connect(request, 'disable');
			return await runOperation(client, request.operation);
		}
		throw error;
	} finally {
		if (client) await client.end().catch(() => {});
	}
}

async function connect(
	request: PostgresWorkerRequest,
	mode: PostgresWorkerRequest['connection']['tls']['mode'],
): Promise<PgClient> {
	const lookup: LookupFunction = (_hostname, options, callback) => {
		if (typeof options === 'object' && options.all) callback(null, request.pinned);
		else callback(null, request.pinned[0].address, request.pinned[0].family);
	};
	let stream: ReturnType<typeof netConnect> | undefined;
	const ssl = postgresSslOptions(request.connection.tls, mode);
	const connection = new BoundedConnection({
		stream: () => {
			stream ??= netConnect({
				host: request.connection.host,
				port: request.connection.port,
				lookup,
			});
			activeSocket = stream;
			return stream;
		},
		ssl,
		keepAlive: false,
	});
	const client = new Client({
		host: request.connection.host,
		port: request.connection.port,
		database: request.connection.database,
		user: request.connection.username,
		password: request.connection.password,
		application_name: 'marimohub-data-browser',
		connectionTimeoutMillis: 10_000,
		keepAlive: false,
		ssl,
		connection,
	} as ConstructorParameters<typeof Client>[0] & { connection: BoundedConnection });
	try {
		await client.connect();
		const backend = client as PgClient & { processID: number; secretKey: number };
		activeCancel = {
			host: request.connection.host,
			port: request.connection.port,
			lookup,
			tls: request.connection.tls,
			processId: backend.processID,
			secretKey: backend.secretKey,
		};
		return client;
	} catch (error) {
		stream?.destroy();
		throw error;
	}
}

function cancelActiveQuery(): void {
	const cancel = activeCancel;
	if (!cancel) {
		activeSocket?.destroy();
		return;
	}
	void sendCancel(cancel).finally(() => activeSocket?.destroy());
	setTimeout(() => activeSocket?.destroy(), 400).unref();
}

async function sendCancel(cancel: NonNullable<typeof activeCancel>): Promise<void> {
	if (cancel.tls.mode === 'disable') {
		await sendPlainCancel(cancel);
		return;
	}
	try {
		await sendEncryptedCancel(cancel);
	} catch (error) {
		if (cancel.tls.mode !== 'prefer' || !postgresTlsUnavailable(error)) throw error;
		await sendPlainCancel(cancel);
	}
}

function cancelPacket(cancel: NonNullable<typeof activeCancel>): Buffer {
	const packet = Buffer.allocUnsafe(16);
	packet.writeInt32BE(16, 0);
	packet.writeInt32BE(CANCEL_REQUEST_CODE, 4);
	packet.writeInt32BE(cancel.processId, 8);
	packet.writeInt32BE(cancel.secretKey, 12);
	return packet;
}

function sendPlainCancel(cancel: NonNullable<typeof activeCancel>): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host: cancel.host, port: cancel.port, lookup: cancel.lookup });
		socket.once('connect', () => socket.end(cancelPacket(cancel), resolve));
		socket.once('error', reject);
	});
}

function sendEncryptedCancel(cancel: NonNullable<typeof activeCancel>): Promise<void> {
	const ssl = postgresSslOptions(cancel.tls);
	if (ssl === false) return sendPlainCancel(cancel);
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host: cancel.host, port: cancel.port, lookup: cancel.lookup });
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(error);
		};
		socket.once('error', fail);
		socket.once('data', (response) => {
			if (response.length !== 1) {
				fail(new Error('Invalid PostgreSQL TLS response.'));
				return;
			}
			if (response[0] === 'N'.charCodeAt(0)) {
				fail(tlsUnavailable());
				return;
			}
			if (response[0] !== 'S'.charCodeAt(0)) {
				fail(new Error('Invalid PostgreSQL TLS response.'));
				return;
			}
			socket.removeListener('error', fail);
			const secure = tlsConnect({ ...ssl, socket, servername: cancel.host });
			secure.once('error', fail);
			secure.once('secureConnect', () => {
				secure.end(cancelPacket(cancel), () => {
					if (settled) return;
					settled = true;
					resolve();
				});
			});
		});
		socket.once('connect', () => {
			const request = Buffer.allocUnsafe(8);
			request.writeInt32BE(8, 0);
			request.writeInt32BE(SSL_REQUEST_CODE, 4);
			socket.write(request);
		});
	});
}

async function runOperation(client: PgClient, operation: PostgresOperation) {
	await client.query('BEGIN TRANSACTION READ ONLY');
	try {
		const timeout = operation.type === 'query' ? operation.deadlineMs : 10_000;
		await client.query("SELECT set_config('statement_timeout', $1, true)", [`${timeout}ms`]);
		await client.query("SELECT set_config('lock_timeout', $1, true)", [
			`${Math.min(timeout, 2_000)}ms`,
		]);
		await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [
			`${timeout}ms`,
		]);
		switch (operation.type) {
			case 'test':
				await client.query('SELECT 1');
				return { connected: true as const };
			case 'namespaces':
				return await listNamespaces(client, operation);
			case 'tables':
				return await listTables(client, operation);
			case 'schema':
				return await describeTable(client, operation);
			case 'preview':
				return await streamRows(
					client,
					`SELECT * FROM ${quoteIdentifier(operation.schema)}.${quoteIdentifier(operation.table)} LIMIT ${operation.limit}`,
					operation.limit,
					operation.maxBytes,
					false,
				);
			case 'query': {
				const query = postgresQuery(operation.sql, operation.maxRows);
				return await streamRows(client, query.sql, operation.maxRows, operation.maxBytes, true);
			}
		}
	} finally {
		await client.query('ROLLBACK').catch(() => {});
	}
}

async function listNamespaces(
	client: PgClient,
	operation: Extract<PostgresOperation, { type: 'namespaces' }>,
) {
	const connection = boundedConnection(client);
	connection.setMaxDataRowBytes(MAX_METADATA_DATA_ROW_FRAME_BYTES);
	const result = await client.query({
		text: `
			SELECT n.nspname
			FROM pg_catalog.pg_namespace AS n
			WHERE n.nspname <> 'information_schema'
				AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
				AND has_schema_privilege(n.oid, 'USAGE')
				AND ($1::text IS NULL OR n.nspname > $1)
			ORDER BY n.nspname
			LIMIT $2`,
		values: [operation.after ?? null, operation.limit + 1],
		rowMode: 'array',
	});
	if (connection.consumeOversizedDataRow()) throw malformed();
	const names = result.rows.map((row) => String(row[0]));
	return page(names, operation.limit, (name) => [name]);
}

async function listTables(
	client: PgClient,
	operation: Extract<PostgresOperation, { type: 'tables' }>,
) {
	const connection = boundedConnection(client);
	connection.setMaxDataRowBytes(MAX_METADATA_DATA_ROW_FRAME_BYTES);
	const result = await client.query({
		text: `
			SELECT c.relname
			FROM pg_catalog.pg_class AS c
			JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
			WHERE n.nspname = $1
				AND has_schema_privilege(n.oid, 'USAGE')
				AND c.relkind = ANY (ARRAY['r', 'p', 'v', 'm', 'f']::"char"[])
				AND has_table_privilege(c.oid, 'SELECT')
				AND ($2::text IS NULL OR c.relname > $2)
			ORDER BY c.relname
			LIMIT $3`,
		values: [operation.schema, operation.after ?? null, operation.limit + 1],
		rowMode: 'array',
	});
	if (connection.consumeOversizedDataRow()) throw malformed();
	const names = result.rows.map((row) => String(row[0]));
	return page(names, operation.limit, (name) => name);
}

async function describeTable(
	client: PgClient,
	operation: Extract<PostgresOperation, { type: 'schema' }>,
) {
	const connection = boundedConnection(client);
	connection.setMaxDataRowBytes(MAX_METADATA_DATA_ROW_FRAME_BYTES);
	const result = await client.query({
		text: `
			SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
				a.attnotnull, pg_catalog.col_description(a.attrelid, a.attnum)
			FROM pg_catalog.pg_attribute AS a
			JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
			JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
			WHERE n.nspname = $1 AND c.relname = $2
				AND has_schema_privilege(n.oid, 'USAGE')
				AND c.relkind = ANY (ARRAY['r', 'p', 'v', 'm', 'f']::"char"[])
				AND has_table_privilege(c.oid, 'SELECT')
				AND a.attnum > 0 AND NOT a.attisdropped
			ORDER BY a.attnum`,
		values: [operation.schema, operation.table],
		rowMode: 'array',
	});
	if (connection.consumeOversizedDataRow()) throw malformed();
	if (result.rows.length === 0) throw rejected();
	return {
		columns: result.rows.map((row) => ({
			name: String(row[0]),
			type: String(row[1]),
			nullable: !row[2],
			...(row[3] === null ? {} : { comment: String(row[3]) }),
		})),
	};
}

async function streamRows(
	client: PgClient,
	sql: string,
	maxRows: number,
	maxBytes: number,
	includeTruncated: boolean,
) {
	const resultMaxBytes = Math.min(maxBytes, MAX_WORKER_RESULT_BYTES);
	const connection = boundedConnection(client);
	connection.setMaxDataRowBytes(Math.min(MAX_DATA_ROW_FRAME_BYTES, resultMaxBytes));
	const cursor = client.query(
		new Cursor<unknown[]>(sql, [], { rowMode: 'array', types: RAW_TEXT_TYPES }),
	);
	let closed = false;
	try {
		const rows: unknown[][] = [];
		let columns: string[] | undefined;
		let bytes = 0;
		let fetched = 0;
		let truncated = false;
		read: while (fetched <= maxRows) {
			const requested = Math.min(CURSOR_BATCH_ROWS, maxRows + 1 - fetched);
			const { rows: rawRows, fields } = await readCursor(cursor, requested);
			columns ??= fields.map((field) => field.name);
			if (bytes === 0) {
				bytes = Buffer.byteLength(JSON.stringify({ columns, rows: [], truncated: false }));
			}
			if (rawRows.length === 0) break;
			for (const raw of rawRows) {
				fetched++;
				if (fetched > maxRows) {
					truncated = true;
					break read;
				}
				if (!Array.isArray(raw)) throw malformed();
				if (connection.consumeOversizedDataRow()) {
					truncated = true;
					break read;
				}
				const remaining = resultMaxBytes - bytes;
				if (rawTextBytes(raw) > remaining) {
					truncated = true;
					break read;
				}
				const row = raw.map((value, index) => parseAndNormalizeValue(value, fields[index]));
				const rowBytes = Buffer.byteLength(JSON.stringify(row)) + (rows.length === 0 ? 0 : 1);
				if (bytes + rowBytes > resultMaxBytes) {
					truncated = true;
					break read;
				}
				rows.push(row);
				bytes += rowBytes;
			}
			if (rawRows.length < requested) break;
			connection.setMaxDataRowBytes(
				Math.min(MAX_DATA_ROW_FRAME_BYTES, Math.max(5, resultMaxBytes - bytes)),
			);
		}
		await cursor.close();
		closed = true;
		columns ??= [];
		return includeTruncated ? { columns, rows, truncated } : { columns, rows };
	} finally {
		if (!closed) await cursor.close().catch(() => {});
	}
}

const RAW_TEXT_TYPES: CustomTypesConfig = {
	getTypeParser: () => (value: string) => value,
};

function rawTextBytes(row: unknown[]): number {
	let bytes = 0;
	for (const value of row) {
		if (value === null) continue;
		if (typeof value !== 'string') throw malformed();
		bytes += Buffer.byteLength(value);
	}
	return bytes;
}

function parseAndNormalizeValue(value: unknown, field: FieldDef | undefined): unknown {
	if (value === null) return null;
	if (typeof value !== 'string' || field === undefined) throw malformed();
	try {
		return normalizeValue(pg.types.getTypeParser(field.dataTypeID, 'text')(value));
	} catch (error) {
		if ((error as { marimohubCode?: unknown } | null)?.marimohubCode === 'malformed_result') {
			throw error;
		}
		throw malformed();
	}
}

class BoundedConnection extends Connection {
	private maxDataRowBytes = Number.MAX_SAFE_INTEGER;
	private oversizedDataRow = false;

	setMaxDataRowBytes(value: number): void {
		this.maxDataRowBytes = value;
	}

	consumeOversizedDataRow(): boolean {
		const oversized = this.oversizedDataRow;
		this.oversizedDataRow = false;
		return oversized;
	}

	attachListeners(stream: Duplex): void {
		const guarded = new PostgresFrameGuard(
			() => this.maxDataRowBytes,
			() => {
				this.oversizedDataRow = true;
			},
		);
		stream.pipe(guarded);
		const attach = Reflect.get(Connection.prototype, 'attachListeners');
		if (typeof attach !== 'function')
			throw new Error('PostgreSQL protocol listener is unavailable.');
		Reflect.apply(attach, this, [guarded]);
	}
}

function boundedConnection(client: PgClient): BoundedConnection {
	return client.connection as BoundedConnection;
}

export class PostgresFrameGuard extends Transform {
	private readonly maxDataRowBytes: () => number;
	private readonly onOversizedDataRow: () => void;
	private readonly header = Buffer.allocUnsafe(5);
	private headerBytes = 0;
	private bodyBytes = 0;
	private droppingDataRow = false;
	private readonly fieldCount = Buffer.allocUnsafe(2);
	private fieldCountBytes = 0;

	constructor(maxDataRowBytes: () => number, onOversizedDataRow: () => void) {
		super();
		this.maxDataRowBytes = maxDataRowBytes;
		this.onOversizedDataRow = onOversizedDataRow;
	}

	override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
		try {
			let offset = 0;
			while (offset < chunk.length) {
				if (this.bodyBytes === 0) {
					const headerTake = Math.min(5 - this.headerBytes, chunk.length - offset);
					chunk.copy(this.header, this.headerBytes, offset, offset + headerTake);
					this.headerBytes += headerTake;
					offset += headerTake;
					if (this.headerBytes < 5) continue;
					const length = this.header.readUInt32BE(1);
					if (length < 4) throw new Error('Invalid PostgreSQL frame.');
					this.bodyBytes = length - 4;
					this.droppingDataRow = this.header[0] === 0x44 && length + 1 > this.maxDataRowBytes();
					if (!this.droppingDataRow) this.push(Buffer.from(this.header));
					this.headerBytes = 0;
					if (this.bodyBytes === 0) this.finishFrame();
					continue;
				}

				const bodyTake = Math.min(this.bodyBytes, chunk.length - offset);
				if (this.droppingDataRow) {
					const fieldTake = Math.min(2 - this.fieldCountBytes, bodyTake);
					if (fieldTake > 0) {
						chunk.copy(this.fieldCount, this.fieldCountBytes, offset, offset + fieldTake);
						this.fieldCountBytes += fieldTake;
					}
				} else {
					this.push(chunk.subarray(offset, offset + bodyTake));
				}
				offset += bodyTake;
				this.bodyBytes -= bodyTake;
				if (this.bodyBytes === 0) this.finishFrame();
			}
			callback();
		} catch (error) {
			callback(error instanceof Error ? error : new Error('Invalid PostgreSQL frame.'));
		}
	}

	private finishFrame(): void {
		if (this.droppingDataRow) {
			if (this.fieldCountBytes !== 2) throw new Error('Invalid PostgreSQL data row.');
			const columns = this.fieldCount.readUInt16BE(0);
			const replacement = Buffer.allocUnsafe(7 + columns * 4);
			replacement[0] = 0x44;
			replacement.writeUInt32BE(6 + columns * 4, 1);
			replacement.writeUInt16BE(columns, 5);
			for (let index = 0; index < columns; index++) replacement.writeInt32BE(-1, 7 + index * 4);
			this.onOversizedDataRow();
			this.push(replacement);
		}
		this.droppingDataRow = false;
		this.fieldCountBytes = 0;
	}
}

function readCursor(
	cursor: Cursor<unknown[]>,
	rowCount: number,
): Promise<{ rows: unknown[][]; fields: FieldDef[] }> {
	return new Promise((resolve, reject) => {
		cursor.read(rowCount, (error, rows, result: QueryResult) => {
			if (error) reject(error);
			else resolve({ rows, fields: result.fields });
		});
	});
}

function normalizeValue(value: unknown): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'bigint') return value.toString();
	if (value instanceof Date) return value.toISOString();
	if (Buffer.isBuffer(value)) return value.toString('base64');
	if (Array.isArray(value)) return value.map(normalizeValue);
	if (typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
				key,
				normalizeValue(nested),
			]),
		);
	}
	throw malformed();
}

function page<T, U>(items: T[], limit: number, map: (item: T) => U) {
	const selected = items.slice(0, limit);
	return {
		items: selected.map(map),
		next_cursor:
			items.length > selected.length ? `name:${encodeURIComponent(String(selected.at(-1)))}` : null,
	};
}

function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function rejected() {
	return Object.assign(new Error('Query rejected.'), { marimohubCode: 'query_rejected' });
}

function malformed() {
	return Object.assign(new Error('Malformed result.'), { marimohubCode: 'malformed_result' });
}

function tlsUnavailable(): Error {
	return Object.assign(new Error('PostgreSQL TLS is unavailable.'), {
		marimohubTlsUnavailable: true,
	});
}

function classifyFailure(error: unknown, operation: PostgresOperation): PostgresWorkerFailure {
	if (error instanceof PostgresStatementTypeError) {
		return { code: 'query_rejected', reason: 'statement_type' };
	}
	const own = (error as { marimohubCode?: unknown } | null)?.marimohubCode;
	if (own === 'query_rejected' || own === 'malformed_result') return { code: own };
	const code = (error as { code?: unknown } | null)?.code;
	if (code === '28P01' || code === '28000') return { code: 'authentication' };
	if (code === '57014') return { code: 'timeout' };
	if (typeof code === 'string' && code.startsWith('25'))
		return queryFailure(error, operation, code);
	if (typeof code === 'string' && /(CERT|TLS|VERIFY|ISSUER|SIGNATURE|SELF_SIGNED)/.test(code)) {
		return { code: 'tls' };
	}
	if (postgresTlsUnavailable(error)) return { code: 'tls' };
	if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
		return queryFailure(error, operation, code);
	}
	return { code: 'connection' };
}

function queryFailure(
	error: unknown,
	operation: PostgresOperation,
	sqlState: string,
): PostgresWorkerFailure {
	const rawPosition = (error as { position?: unknown } | null)?.position;
	const parsed =
		typeof rawPosition === 'string' && /^[1-9][0-9]{0,8}$/.test(rawPosition)
			? Number(rawPosition)
			: undefined;
	const position =
		operation.type === 'query' && parsed !== undefined && parsed > QUERY_WRAPPER_PREFIX.length
			? parsed -
				QUERY_WRAPPER_PREFIX.length +
				postgresQuery(operation.sql, operation.maxRows).leadingOffset
			: undefined;
	return { code: 'query_rejected', sqlState, ...(position === undefined ? {} : { position }) };
}
