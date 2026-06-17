import { bucketContract } from './bucketContract';
import { MemoryBucket } from './MemoryBucket';

// Validate the shared contract against the known-good in-memory adapter.
bucketContract('MemoryBucket', () => new MemoryBucket());
