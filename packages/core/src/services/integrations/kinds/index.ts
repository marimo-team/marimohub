import { IntegrationRegistry } from '../registry';
import { athena, redshift } from './awsQueryEngines';
import { bigquery } from './bigquery';
import { clickhouse } from './clickhouse';
import { customEnv } from './customEnv';
import { databricks } from './databricks';
import { ducklake } from './ducklake';
import { duckdbHttp } from './duckdbHttp';
import {
	icebergBigQuery,
	icebergDynamoDb,
	icebergGlue,
	icebergHive,
	icebergSql,
} from './icebergCatalogs';
import { icebergRest } from './icebergRest';
import { huggingFace, wandb } from './mlPlatforms';
import { mongodb } from './mongodb';
import { motherduck } from './motherduck';
import { mysql } from './mysql';
import { azureBlob, gcs, s3 } from './objectStores';
import { postgres } from './postgres';
import { pyspark } from './pyspark';
import { snowflake } from './snowflake';
import { sqlserver } from './sqlserver';
import { trino } from './trino';

export { athena, redshift } from './awsQueryEngines';
export { bigquery } from './bigquery';
export { clickhouse } from './clickhouse';
export { customEnv } from './customEnv';
export { databricks } from './databricks';
export { ducklake } from './ducklake';
export { duckdbHttp } from './duckdbHttp';
export {
	icebergBigQuery,
	icebergDynamoDb,
	icebergGlue,
	icebergHive,
	icebergSql,
} from './icebergCatalogs';
export { icebergRest } from './icebergRest';
export { huggingFace, wandb } from './mlPlatforms';
export { mongodb } from './mongodb';
export { motherduck } from './motherduck';
export { mysql } from './mysql';
export { azureBlob, gcs, s3 } from './objectStores';
export { postgres } from './postgres';
export { pyspark } from './pyspark';
export { snowflake } from './snowflake';
export { sqlserver } from './sqlserver';
export { trino } from './trino';

export function defaultRegistry(): IntegrationRegistry {
	const registry = new IntegrationRegistry();
	registry.register(postgres);
	registry.register(mysql);
	registry.register(sqlserver);
	registry.register(mongodb);
	registry.register(clickhouse);
	registry.register(snowflake);
	registry.register(bigquery);
	registry.register(redshift);
	registry.register(motherduck);
	registry.register(ducklake);
	registry.register(duckdbHttp);
	registry.register(icebergRest);
	registry.register(icebergSql);
	registry.register(icebergHive);
	registry.register(icebergGlue);
	registry.register(icebergDynamoDb);
	registry.register(icebergBigQuery);
	registry.register(trino);
	registry.register(pyspark);
	registry.register(databricks);
	registry.register(athena);
	registry.register(s3);
	registry.register(gcs);
	registry.register(azureBlob);
	registry.register(wandb);
	registry.register(huggingFace);
	registry.register(customEnv);
	return registry;
}
