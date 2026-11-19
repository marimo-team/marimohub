import { PostgresMetadataStore } from '@marimo-hub/metadata-postgres';
import type { MetadataFactory } from './metadata';
export const nodeMetadataFactory: MetadataFactory = (settings) =>
	new PostgresMetadataStore(settings);
export {
	auditMetadataDeployment,
	runMetadataTransfer,
	migrateMetadataSchema,
	inspectMetadataDeployment,
} from '@marimo-hub/metadata-postgres/admin';
