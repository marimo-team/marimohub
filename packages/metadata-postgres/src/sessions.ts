import type { IndexedSessionRecords, SessionRecordQuery } from '@marimo-hub/core/ports/metadata';
import type { PoolClient } from 'pg';
import { body, COLUMNS, decodeCursor, encodeCursor } from './records';
import type { RecordRow } from './records';

export async function listSessions(
	client: PoolClient,
	namespace: string,
	epoch: number,
	query: SessionRecordQuery,
): ReturnType<IndexedSessionRecords['list']> {
	if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000)
		throw new RangeError('Session query limit must be between 1 and 1000');
	const binding = JSON.stringify([
		1,
		namespace,
		epoch,
		query.userId ?? null,
		query.projectId ?? null,
		query.notebookId ?? null,
		query.heartbeatBefore ?? null,
		query.expiresBefore ?? null,
		query.authorizationExpiresBefore ?? null,
		query.unreclaimedOnly ?? false,
	]);
	const cursor = decodeCursor(query.cursor, binding);
	const args: unknown[] = [namespace, cursor?.after ?? ''];
	const predicates = ['namespace=$1', 'key>$2', 'session_id IS NOT NULL'];
	for (const [column, value] of [
		['user_id', query.userId],
		['project_id', query.projectId],
		['notebook_id', query.notebookId],
	]) {
		if (value !== undefined) {
			args.push(value);
			predicates.push(`${column}=$${args.length}`);
		}
	}
	for (const [column, value] of [
		['session_last_heartbeat', query.heartbeatBefore],
		['session_expires_at', query.expiresBefore],
		['session_authorization_expires_at', query.authorizationExpiresBefore],
	]) {
		if (value !== undefined) {
			args.push(value);
			predicates.push(`${column}<hub_metadata.session_time($${args.length})`);
		}
	}
	if (query.unreclaimedOnly)
		predicates.push('session_sandbox_id IS NOT NULL AND session_reclaimed_at IS NULL');
	args.push(query.limit + 1);
	const result = await client.query<RecordRow>(
		`SELECT ${COLUMNS}, body FROM hub_metadata.records WHERE ${predicates.join(' AND ')} ORDER BY key COLLATE "C" LIMIT $${args.length}`,
		args,
	);
	const rows = result.rows.slice(0, query.limit);
	return {
		records: rows.map(body),
		...(result.rows.length > query.limit
			? { cursor: encodeCursor(binding, rows[rows.length - 1].key) }
			: {}),
	};
}
