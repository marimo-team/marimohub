import { migrateMetadataSchema } from '@marimo-hub/config/metadata.node';

const url = process.env.MARIMOHUB_METADATA_ADMIN_POSTGRES_URL;
if (!url) throw new Error('MARIMOHUB_METADATA_ADMIN_POSTGRES_URL is required');
await migrateMetadataSchema(url);
console.log('Metadata schema migrations applied.');
