import { PreconditionFailedError } from '@marimo-hub/core/errors';
import {
	assertValidBucketListLimit,
	bucketMetadataFingerprint,
} from '@marimo-hub/core/ports/bucket';
import type {
	BucketGetOptions,
	BucketGetResult,
	BucketListOptions,
	BucketListResult,
	BucketObject,
	BucketObjectBody,
	BucketPutOptions,
} from '@marimo-hub/core/ports/bucket';
import type { PoolClient } from 'pg';
import { isValidMetadataIdentifier } from './validation';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const COLUMNS = 'key, etag, size_bytes, uploaded_at, http_metadata, custom_metadata';
export interface RecordRow {
	key: string;
	etag: string;
	size_bytes: string;
	uploaded_at: Date;
	http_metadata: BucketPutOptions['httpMetadata'] | null;
	custom_metadata: BucketPutOptions['customMetadata'] | null;
	body: Buffer;
}

export function object(row: RecordRow): BucketObject {
	return {
		key: row.key,
		etag: row.etag,
		size: Number(row.size_bytes),
		uploaded: row.uploaded_at,
		...(row.http_metadata ? { httpMetadata: row.http_metadata } : {}),
		...(row.custom_metadata ? { customMetadata: row.custom_metadata } : {}),
	};
}
export function body(row: RecordRow): BucketObjectBody {
	return {
		...object(row),
		text: async () => row.body.toString('utf8'),
		json: async <T>() => JSON.parse(row.body.toString('utf8')) as T,
		bytes: async () => Uint8Array.from(row.body),
	};
}
export function validateKey(key: string): void {
	if (!isValidMetadataIdentifier(key, 1024)) throw new RangeError('Invalid metadata key');
}

export async function matchesRecord(
	row: RecordRow,
	candidate: BucketObjectBody | null,
): Promise<boolean> {
	return (
		candidate !== null &&
		Buffer.from(await candidate.bytes()).equals(row.body) &&
		bucketMetadataFingerprint(candidate) === bucketMetadataFingerprint(object(row))
	);
}

export function encodeCursor(binding: string, after: string, rolled?: string): string {
	return Buffer.from(JSON.stringify([binding, after, rolled ?? null])).toString('base64url');
}
export function decodeCursor(
	token: string | undefined,
	binding: string,
): { after: string; rolled?: string } | undefined {
	if (!token) return undefined;
	try {
		const data: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
		if (
			!Array.isArray(data) ||
			data.length !== 3 ||
			data[0] !== binding ||
			typeof data[1] !== 'string' ||
			(data[2] !== null && typeof data[2] !== 'string')
		)
			throw new Error('Invalid cursor shape');
		return { after: data[1], rolled: data[2] ?? undefined };
	} catch {
		throw new RangeError('Invalid metadata cursor');
	}
}
export function likePrefix(prefix: string): string {
	return `${prefix.replaceAll(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export async function getRecord(
	client: PoolClient,
	namespace: string,
	key: string,
	options?: BucketGetOptions,
): Promise<BucketGetResult> {
	validateKey(key);
	const result = await client.query<RecordRow>(
		`SELECT ${COLUMNS}, body FROM hub_metadata.records WHERE namespace=$1 AND key=$2`,
		[namespace, key],
	);
	const row = result.rows[0];
	if (!row) return null;
	if (options?.ifNoneMatch && options.ifNoneMatch === row.etag)
		return { key, etag: row.etag, notModified: true };
	return body(row);
}
export async function headRecord(
	client: PoolClient,
	namespace: string,
	key: string,
): Promise<BucketObject | null> {
	validateKey(key);
	const result = await client.query<RecordRow>(
		`SELECT ${COLUMNS} FROM hub_metadata.records WHERE namespace=$1 AND key=$2`,
		[namespace, key],
	);
	return result.rows[0] ? object(result.rows[0]) : null;
}
export async function putRecord(
	client: PoolClient,
	namespace: string,
	key: string,
	value: string | Uint8Array,
	options: BucketPutOptions = {},
): Promise<BucketObject> {
	validateKey(key);
	if (options.onlyIfEtagMatches !== undefined && options.onlyIfNotExists)
		throw new RangeError('Conditional put flags are mutually exclusive');
	const args: unknown[] = [
		namespace,
		key,
		Buffer.from(value),
		options.httpMetadata ?? null,
		options.customMetadata ?? null,
	];
	let sql: string;
	if (options.onlyIfEtagMatches !== undefined) {
		if (!UUID.test(options.onlyIfEtagMatches)) throw new PreconditionFailedError();
		args.push(options.onlyIfEtagMatches);
		sql = `UPDATE hub_metadata.records SET body=$3, http_metadata=$4, custom_metadata=$5 WHERE namespace=$1 AND key=$2 AND etag=$6::uuid RETURNING ${COLUMNS}`;
	} else {
		sql = `INSERT INTO hub_metadata.records(namespace,key,body,http_metadata,custom_metadata) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(namespace,key) ${options.onlyIfNotExists ? 'DO NOTHING' : 'DO UPDATE SET body=EXCLUDED.body, http_metadata=EXCLUDED.http_metadata, custom_metadata=EXCLUDED.custom_metadata'} RETURNING ${COLUMNS}`;
	}
	const result = await client.query<RecordRow>(sql, args);
	if (!result.rows[0]) throw new PreconditionFailedError();
	return object(result.rows[0]);
}
export async function deleteRecords(
	client: PoolClient,
	namespace: string,
	keys: string | string[],
): Promise<void> {
	const selected = typeof keys === 'string' ? [keys] : keys;
	selected.forEach(validateKey);
	for (let offset = 0; offset < selected.length; offset += 1000) {
		await client.query(
			'DELETE FROM hub_metadata.records WHERE namespace=$1 AND key=ANY($2::text[])',
			[namespace, selected.slice(offset, offset + 1000)],
		);
	}
}
function prefixUpperBound(prefix: string): string | undefined {
	// UTF-8 key bounds use scalar values, not grapheme clusters.
	// eslint-disable-next-line @typescript-eslint/no-misused-spread
	const chars = [...prefix];
	while (chars.length > 0) {
		const last = chars.pop()!.codePointAt(0)!;
		if (last < 0x10ffff)
			return chars.join('') + String.fromCodePoint(last === 0xd7ff ? 0xe000 : last + 1);
	}
	return undefined;
}

export async function listRecords(
	client: PoolClient,
	namespace: string,
	epoch: number,
	options: BucketListOptions = {},
): Promise<BucketListResult> {
	assertValidBucketListLimit(options.limit);
	const prefix = options.prefix ?? '';
	const delimiter = options.delimiter ?? '';
	const binding = JSON.stringify([1, namespace, epoch, prefix, delimiter]);
	const cursor = decodeCursor(options.cursor, binding);
	let after = cursor?.after ?? options.startAfter ?? '';
	let rolled = cursor?.rolled;
	let lowerBound = rolled ? prefixUpperBound(rolled) : undefined;
	const objects: BucketObject[] = [];
	const delimitedPrefixes: string[] = [];
	const limit = options.limit ?? 1000;
	while (true) {
		if (rolled && lowerBound === undefined) return { objects, delimitedPrefixes, truncated: false };
		let jumped = false;
		const rows = (
			await client.query<RecordRow>(
				`SELECT ${COLUMNS} FROM hub_metadata.records WHERE namespace=$1 AND key LIKE $2 AND key>$3 AND ($5::text IS NULL OR key>=$5) ORDER BY key COLLATE "C" LIMIT $4`,
				[namespace, likePrefix(prefix), after, Math.min(limit + 1, 1000), lowerBound ?? null],
			)
		).rows;
		for (const row of rows) {
			const index = delimiter ? row.key.indexOf(delimiter, prefix.length) : -1;
			const nextPrefix = index < 0 ? undefined : row.key.slice(0, index + delimiter.length);
			if (!nextPrefix || nextPrefix !== rolled) {
				if (objects.length + delimitedPrefixes.length === limit)
					return {
						objects,
						delimitedPrefixes,
						truncated: true,
						cursor: encodeCursor(binding, after, rolled),
					};
				if (nextPrefix) delimitedPrefixes.push(nextPrefix);
				else objects.push(object(row));
				rolled = nextPrefix;
			}
			after = row.key;
			if (nextPrefix) {
				lowerBound = prefixUpperBound(nextPrefix);
				jumped = true;
				break;
			}
		}
		if (jumped) continue;
		if (rows.length < Math.min(limit + 1, 1000))
			return { objects, delimitedPrefixes, truncated: false };
	}
}
