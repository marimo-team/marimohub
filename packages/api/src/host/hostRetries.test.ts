import { HostRetryStore } from '@marimo-hub/core';
import { MemoryBucket } from '@marimo-hub/core/testing/memory-bucket';
import { hostRetryStoreContract } from '@marimo-hub/host-protocol/testing';
import { hubErrorStatus } from './platform';

hostRetryStoreContract('HostRetryStore', () => new HostRetryStore(new MemoryBucket()), {
	errorStatus: hubErrorStatus,
});
