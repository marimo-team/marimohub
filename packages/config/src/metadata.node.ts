import { PostgresMetadataStore } from '@marimo-hub/metadata-postgres';
import type { MetadataFactory } from './metadata';
export const nodeMetadataFactory: MetadataFactory = (settings) =>
	new PostgresMetadataStore(settings);
export {
	migrateMetadataSchema,
	inspectMetadataDeployment,
} from '@marimo-hub/metadata-postgres/admin';
