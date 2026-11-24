import { metadataPostgresUrl } from '@marimo-hub/config/metadata';
import { migrateMetadataSchema } from '@marimo-hub/config/metadata.node';

const url = metadataPostgresUrl(process.env, 'MARIMOHUB_METADATA_ADMIN_POSTGRES_URL', true);
await migrateMetadataSchema(url);
console.log('Metadata schema migrations applied.');
