import type { NotebookId, ProjectId, UserId } from '../ids';
import type { Bucket, BucketObjectBody } from './bucket';

export type MetadataStore = Pick<Bucket, 'get' | 'head' | 'put' | 'delete' | 'list'>;

export interface SessionRecordQuery {
	userId?: UserId;
	projectId?: ProjectId;
	notebookId?: NotebookId;
	heartbeatBefore?: string;
	expiresBefore?: string;
	authorizationExpiresBefore?: string;
	unreclaimedOnly?: boolean;
	cursor?: string;
	limit: number;
}

export interface IndexedSessionRecords {
	/** Candidates only: callers must validate bodies and apply domain policy. */
	list(query: SessionRecordQuery): Promise<{
		records: BucketObjectBody[];
		cursor?: string;
	}>;
}

export interface HubStorage {
	artifacts: Bucket;
	metadata: MetadataStore;
	sessions?: IndexedSessionRecords;
	logicalBucket: Bucket;
}

export function bucketStorage(bucket: Bucket): HubStorage {
	return { artifacts: bucket, metadata: bucket, logicalBucket: bucket };
}
