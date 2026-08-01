import { IntegrationRegistry } from '../registry';
import { customEnv } from './customEnv';
import {
	icebergBigQuery,
	icebergDynamoDb,
	icebergGlue,
	icebergHive,
	icebergSql,
} from './icebergCatalogs';
import { icebergRest } from './icebergRest';
import { postgres } from './postgres';
import { pyspark } from './pyspark';
import { trino } from './trino';

export { customEnv } from './customEnv';
export {
	icebergBigQuery,
	icebergDynamoDb,
	icebergGlue,
	icebergHive,
	icebergSql,
} from './icebergCatalogs';
export { icebergRest } from './icebergRest';
export { postgres } from './postgres';
export { pyspark } from './pyspark';
export { trino } from './trino';

export function defaultRegistry(): IntegrationRegistry {
	const registry = new IntegrationRegistry();
	registry.register(postgres);
	registry.register(icebergRest);
	registry.register(icebergSql);
	registry.register(icebergHive);
	registry.register(icebergGlue);
	registry.register(icebergDynamoDb);
	registry.register(icebergBigQuery);
	registry.register(trino);
	registry.register(pyspark);
	registry.register(customEnv);
	return registry;
}
