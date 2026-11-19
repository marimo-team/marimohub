import { createHash } from 'node:crypto';
import { migrationSources } from './schema';
import type { Pool, PoolClient } from 'pg';
import { MetadataStorageError, storageError } from './errors';

export async function migrationFiles() {
	return migrationSources.map((sql, index) => ({
		version: index + 1,
		sql,
		checksum: createHash('sha256').update(sql).digest('hex'),
	}));
}

export async function checkSchema(client: PoolClient): Promise<void> {
	const version = await client.query<{ version: string }>(
		"SELECT current_setting('server_version_num') AS version",
	);
	if (Number(version.rows[0].version) < 170000) throw new MetadataStorageError('unavailable');
	const expected = await migrationFiles();
	const applied = await client.query<{ version: string; checksum: string }>(
		'SELECT version, checksum FROM hub_metadata.schema_migrations ORDER BY version',
	);
	if (
		applied.rows.length !== expected.length ||
		expected.some(
			(file, i) =>
				Number(applied.rows[i].version) !== file.version ||
				applied.rows[i].checksum !== file.checksum,
		)
	)
		throw new MetadataStorageError('unavailable');
}

export async function migrateSchema(pool: Pool): Promise<void> {
	const client = await pool.connect();
	let destroy = false;
	try {
		await client.query('BEGIN');
		await client.query('SELECT pg_advisory_xact_lock(184620851, 1)');
		const server = await client.query<{ version: string }>(
			"SELECT current_setting('server_version_num') AS version",
		);
		if (Number(server.rows[0].version) < 170000) throw new MetadataStorageError('unavailable');
		const exists = await client.query<{ name: string | null }>(
			"SELECT to_regclass('hub_metadata.schema_migrations')::text AS name",
		);
		const applied = exists.rows[0].name
			? (
					await client.query<{ version: string; checksum: string }>(
						'SELECT version, checksum FROM hub_metadata.schema_migrations ORDER BY version',
					)
				).rows
			: [];
		const files = await migrationFiles();
		if (applied.length > files.length) throw new MetadataStorageError('unavailable');
		for (const file of files) {
			const previous = applied[file.version - 1];
			if (previous) {
				if (Number(previous.version) !== file.version || previous.checksum !== file.checksum)
					throw new MetadataStorageError('unavailable');
				continue;
			}
			await client.query(file.sql);
			await client.query(
				'INSERT INTO hub_metadata.schema_migrations(version, checksum) VALUES ($1, $2)',
				[file.version, file.checksum],
			);
		}
		await client.query('COMMIT');
	} catch (error) {
		try {
			await client.query('ROLLBACK');
		} catch {
			destroy = true;
		}
		throw storageError(error);
	} finally {
		client.release(destroy);
	}
}
