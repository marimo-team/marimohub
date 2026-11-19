import { bucketStorage } from '../ports/metadata';
import { MemoryBucket } from '../testing/MemoryBucket';
import { metadataCompositionContract } from '../testing/metadataContract';
metadataCompositionContract('memory bucket', async () => bucketStorage(new MemoryBucket()));
