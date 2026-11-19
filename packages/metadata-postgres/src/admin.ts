import { checkSchema, migrateSchema } from './migrations';
import { createMetadataPool } from './pool';
import { storageError } from './errors';

export async function migrateMetadataSchema(url: string): Promise<void> {
	const pool = createMetadataPool({ url, statementTimeoutMs: 60000, lockTimeoutMs: 10000 });
	try {
		await migrateSchema(pool);
	} finally {
		await pool.end();
	}
}

export async function inspectMetadataDeployment(url: string, namespace: string) {
	const pool = createMetadataPool({ url });
	try {
		const client = await pool.connect();
		try {
			await checkSchema(client);
			const deployment = await client.query<{
				backend_epoch: string;
				state: string;
				artifact_store_id: string;
			}>(
				'SELECT backend_epoch,state,artifact_store_id FROM hub_metadata.deployments WHERE namespace=$1',
				[namespace],
			);
			const counts = await client.query<{ records: string; bytes: string }>(
				'SELECT count(*) AS records, coalesce(sum(size_bytes),0) AS bytes FROM hub_metadata.records WHERE namespace=$1',
				[namespace],
			);
			return { deployment: deployment.rows[0] ?? null, ...counts.rows[0] };
		} finally {
			client.release();
		}
	} catch (error) {
		throw storageError(error);
	} finally {
		await pool.end();
	}
}
