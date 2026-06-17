import type { RpcTransport } from "@protobuf-ts/runtime-rpc";
import type { ServiceInfo } from "@protobuf-ts/runtime-rpc";
import type { DeleteObjectStorageWIFConfigResponse } from "./gateway.js";
import type { DeleteObjectStorageWIFConfigRequest } from "./gateway.js";
import type { SetObjectStorageWIFConfigRequest } from "./gateway.js";
import type { ObjectStorageWIFConfig } from "./gateway.js";
import type { GetObjectStorageWIFConfigRequest } from "./gateway.js";
import type { RawSandboxResponse } from "./gateway.js";
import type { RawSandboxRequest } from "./gateway.js";
import type { ResumeSandboxResponse } from "./gateway.js";
import type { ResumeSandboxRequest } from "./gateway.js";
import type { PauseSandboxResponse } from "./gateway.js";
import type { PauseSandboxRequest } from "./gateway.js";
import type { RetrieveFileSandboxResponse } from "./gateway.js";
import type { RetrieveFileSandboxRequest } from "./gateway.js";
import type { AddFileSandboxResponse } from "./gateway.js";
import type { AddFileSandboxRequest } from "./gateway.js";
import type { ExecSandboxResponse } from "./gateway.js";
import type { ExecSandboxRequest } from "./gateway.js";
import type { DeleteSandboxResponse } from "./gateway.js";
import type { DeleteSandboxRequest } from "./gateway.js";
import type { ListSandboxesResponse } from "./gateway.js";
import type { ListSandboxesRequest } from "./gateway.js";
import type { GetSandboxResponse } from "./gateway.js";
import type { GetSandboxRequest } from "./gateway.js";
import type { DeleteFileSystemSnapshotResponse } from "./gateway.js";
import type { DeleteFileSystemSnapshotRequest } from "./gateway.js";
import type { ListFileSystemSnapshotsResponse } from "./gateway.js";
import type { ListFileSystemSnapshotsRequest } from "./gateway.js";
import type { FileSystemSnapshot } from "./gateway.js";
import type { GetFileSystemSnapshotRequest } from "./gateway.js";
import type { CreateFileSystemSnapshotResponse } from "./gateway.js";
import type { CreateFileSystemSnapshotRequest } from "./gateway.js";
import type { StopSandboxResponse } from "./gateway.js";
import type { StopSandboxRequest } from "./gateway.js";
import type { StartSandboxResponse } from "./gateway.js";
import type { StartSandboxRequest } from "./gateway.js";
import type { UnaryCall } from "@protobuf-ts/runtime-rpc";
import type { RpcOptions } from "@protobuf-ts/runtime-rpc";
/**
 * GatewayService provides sandbox management capabilities.
 *
 * @generated from protobuf service coreweave.sandbox.v1beta2.GatewayService
 */
export interface IGatewayServiceClient {
    /**
     * Start launches a new sandbox.
     *
     * @generated from protobuf rpc: Start
     */
    start(input: StartSandboxRequest, options?: RpcOptions): UnaryCall<StartSandboxRequest, StartSandboxResponse>;
    /**
     * Stop terminates a running sandbox.
     *
     * @generated from protobuf rpc: Stop
     */
    stop(input: StopSandboxRequest, options?: RpcOptions): UnaryCall<StopSandboxRequest, StopSandboxResponse>;
    /**
     * CreateFileSystemSnapshot creates an FSS from a running sandbox without stopping it.
     *
     * @generated from protobuf rpc: CreateFileSystemSnapshot
     */
    createFileSystemSnapshot(input: CreateFileSystemSnapshotRequest, options?: RpcOptions): UnaryCall<CreateFileSystemSnapshotRequest, CreateFileSystemSnapshotResponse>;
    /**
     * GetFileSystemSnapshot retrieves an org-scoped FSS by id.
     *
     * @generated from protobuf rpc: GetFileSystemSnapshot
     */
    getFileSystemSnapshot(input: GetFileSystemSnapshotRequest, options?: RpcOptions): UnaryCall<GetFileSystemSnapshotRequest, FileSystemSnapshot>;
    /**
     * ListFileSystemSnapshots lists org-scoped FSS rows.
     *
     * @generated from protobuf rpc: ListFileSystemSnapshots
     */
    listFileSystemSnapshots(input: ListFileSystemSnapshotsRequest, options?: RpcOptions): UnaryCall<ListFileSystemSnapshotsRequest, ListFileSystemSnapshotsResponse>;
    /**
     * DeleteFileSystemSnapshot hides an FSS row from future customer Get/List calls.
     *
     * @generated from protobuf rpc: DeleteFileSystemSnapshot
     */
    deleteFileSystemSnapshot(input: DeleteFileSystemSnapshotRequest, options?: RpcOptions): UnaryCall<DeleteFileSystemSnapshotRequest, DeleteFileSystemSnapshotResponse>;
    /**
     * Get retrieves details about a specific sandbox.
     *
     * @generated from protobuf rpc: Get
     */
    get(input: GetSandboxRequest, options?: RpcOptions): UnaryCall<GetSandboxRequest, GetSandboxResponse>;
    /**
     * List enumerates sandboxes with optional filters.
     *
     * @generated from protobuf rpc: List
     */
    list(input: ListSandboxesRequest, options?: RpcOptions): UnaryCall<ListSandboxesRequest, ListSandboxesResponse>;
    /**
     * Delete removes a sandbox.
     *
     * @generated from protobuf rpc: Delete
     */
    delete(input: DeleteSandboxRequest, options?: RpcOptions): UnaryCall<DeleteSandboxRequest, DeleteSandboxResponse>;
    /**
     * Exec executes a command within a sandbox.
     *
     * @generated from protobuf rpc: Exec
     */
    exec(input: ExecSandboxRequest, options?: RpcOptions): UnaryCall<ExecSandboxRequest, ExecSandboxResponse>;
    /**
     * AddFile writes (or overwrites) a file inside the sandbox filesystem.
     *
     * @generated from protobuf rpc: AddFile
     */
    addFile(input: AddFileSandboxRequest, options?: RpcOptions): UnaryCall<AddFileSandboxRequest, AddFileSandboxResponse>;
    /**
     * RetrieveFile retrieves a file's contents from the sandbox.
     *
     * @generated from protobuf rpc: RetrieveFile
     */
    retrieveFile(input: RetrieveFileSandboxRequest, options?: RpcOptions): UnaryCall<RetrieveFileSandboxRequest, RetrieveFileSandboxResponse>;
    /**
     * Pause pauses a running sandbox.
     *
     * @generated from protobuf rpc: Pause
     */
    pause(input: PauseSandboxRequest, options?: RpcOptions): UnaryCall<PauseSandboxRequest, PauseSandboxResponse>;
    /**
     * Resume resumes a paused sandbox.
     *
     * @generated from protobuf rpc: Resume
     */
    resume(input: ResumeSandboxRequest, options?: RpcOptions): UnaryCall<ResumeSandboxRequest, ResumeSandboxResponse>;
    /**
     * Raw executes a raw action on a sandbox based on action_type.
     *
     * @generated from protobuf rpc: Raw
     */
    raw(input: RawSandboxRequest, options?: RpcOptions): UnaryCall<RawSandboxRequest, RawSandboxResponse>;
    /**
     * Returns the organization's WIF configuration.
     * Derives org_id from the authenticated caller.
     *
     * @generated from protobuf rpc: GetObjectStorageWIFConfig
     */
    getObjectStorageWIFConfig(input: GetObjectStorageWIFConfigRequest, options?: RpcOptions): UnaryCall<GetObjectStorageWIFConfigRequest, ObjectStorageWIFConfig>;
    /**
     * Creates or replaces the organization's WIF configuration.
     * Derives org_id from the authenticated caller.
     * Since there is one config per org, this is an idempotent upsert.
     *
     * @generated from protobuf rpc: SetObjectStorageWIFConfig
     */
    setObjectStorageWIFConfig(input: SetObjectStorageWIFConfigRequest, options?: RpcOptions): UnaryCall<SetObjectStorageWIFConfigRequest, ObjectStorageWIFConfig>;
    /**
     * Deletes the organization's WIF configuration.
     * Running sandboxes are unaffected until their OIDC JWT expires.
     * New sandbox requests with object_storage_access will be rejected.
     *
     * @generated from protobuf rpc: DeleteObjectStorageWIFConfig
     */
    deleteObjectStorageWIFConfig(input: DeleteObjectStorageWIFConfigRequest, options?: RpcOptions): UnaryCall<DeleteObjectStorageWIFConfigRequest, DeleteObjectStorageWIFConfigResponse>;
}
/**
 * GatewayService provides sandbox management capabilities.
 *
 * @generated from protobuf service coreweave.sandbox.v1beta2.GatewayService
 */
export declare class GatewayServiceClient implements IGatewayServiceClient, ServiceInfo {
    private readonly _transport;
    typeName: string;
    methods: import("@protobuf-ts/runtime-rpc").MethodInfo<any, any>[];
    options: {
        [extensionName: string]: import("@protobuf-ts/runtime").JsonValue;
    };
    constructor(_transport: RpcTransport);
    /**
     * Start launches a new sandbox.
     *
     * @generated from protobuf rpc: Start
     */
    start(input: StartSandboxRequest, options?: RpcOptions): UnaryCall<StartSandboxRequest, StartSandboxResponse>;
    /**
     * Stop terminates a running sandbox.
     *
     * @generated from protobuf rpc: Stop
     */
    stop(input: StopSandboxRequest, options?: RpcOptions): UnaryCall<StopSandboxRequest, StopSandboxResponse>;
    /**
     * CreateFileSystemSnapshot creates an FSS from a running sandbox without stopping it.
     *
     * @generated from protobuf rpc: CreateFileSystemSnapshot
     */
    createFileSystemSnapshot(input: CreateFileSystemSnapshotRequest, options?: RpcOptions): UnaryCall<CreateFileSystemSnapshotRequest, CreateFileSystemSnapshotResponse>;
    /**
     * GetFileSystemSnapshot retrieves an org-scoped FSS by id.
     *
     * @generated from protobuf rpc: GetFileSystemSnapshot
     */
    getFileSystemSnapshot(input: GetFileSystemSnapshotRequest, options?: RpcOptions): UnaryCall<GetFileSystemSnapshotRequest, FileSystemSnapshot>;
    /**
     * ListFileSystemSnapshots lists org-scoped FSS rows.
     *
     * @generated from protobuf rpc: ListFileSystemSnapshots
     */
    listFileSystemSnapshots(input: ListFileSystemSnapshotsRequest, options?: RpcOptions): UnaryCall<ListFileSystemSnapshotsRequest, ListFileSystemSnapshotsResponse>;
    /**
     * DeleteFileSystemSnapshot hides an FSS row from future customer Get/List calls.
     *
     * @generated from protobuf rpc: DeleteFileSystemSnapshot
     */
    deleteFileSystemSnapshot(input: DeleteFileSystemSnapshotRequest, options?: RpcOptions): UnaryCall<DeleteFileSystemSnapshotRequest, DeleteFileSystemSnapshotResponse>;
    /**
     * Get retrieves details about a specific sandbox.
     *
     * @generated from protobuf rpc: Get
     */
    get(input: GetSandboxRequest, options?: RpcOptions): UnaryCall<GetSandboxRequest, GetSandboxResponse>;
    /**
     * List enumerates sandboxes with optional filters.
     *
     * @generated from protobuf rpc: List
     */
    list(input: ListSandboxesRequest, options?: RpcOptions): UnaryCall<ListSandboxesRequest, ListSandboxesResponse>;
    /**
     * Delete removes a sandbox.
     *
     * @generated from protobuf rpc: Delete
     */
    delete(input: DeleteSandboxRequest, options?: RpcOptions): UnaryCall<DeleteSandboxRequest, DeleteSandboxResponse>;
    /**
     * Exec executes a command within a sandbox.
     *
     * @generated from protobuf rpc: Exec
     */
    exec(input: ExecSandboxRequest, options?: RpcOptions): UnaryCall<ExecSandboxRequest, ExecSandboxResponse>;
    /**
     * AddFile writes (or overwrites) a file inside the sandbox filesystem.
     *
     * @generated from protobuf rpc: AddFile
     */
    addFile(input: AddFileSandboxRequest, options?: RpcOptions): UnaryCall<AddFileSandboxRequest, AddFileSandboxResponse>;
    /**
     * RetrieveFile retrieves a file's contents from the sandbox.
     *
     * @generated from protobuf rpc: RetrieveFile
     */
    retrieveFile(input: RetrieveFileSandboxRequest, options?: RpcOptions): UnaryCall<RetrieveFileSandboxRequest, RetrieveFileSandboxResponse>;
    /**
     * Pause pauses a running sandbox.
     *
     * @generated from protobuf rpc: Pause
     */
    pause(input: PauseSandboxRequest, options?: RpcOptions): UnaryCall<PauseSandboxRequest, PauseSandboxResponse>;
    /**
     * Resume resumes a paused sandbox.
     *
     * @generated from protobuf rpc: Resume
     */
    resume(input: ResumeSandboxRequest, options?: RpcOptions): UnaryCall<ResumeSandboxRequest, ResumeSandboxResponse>;
    /**
     * Raw executes a raw action on a sandbox based on action_type.
     *
     * @generated from protobuf rpc: Raw
     */
    raw(input: RawSandboxRequest, options?: RpcOptions): UnaryCall<RawSandboxRequest, RawSandboxResponse>;
    /**
     * Returns the organization's WIF configuration.
     * Derives org_id from the authenticated caller.
     *
     * @generated from protobuf rpc: GetObjectStorageWIFConfig
     */
    getObjectStorageWIFConfig(input: GetObjectStorageWIFConfigRequest, options?: RpcOptions): UnaryCall<GetObjectStorageWIFConfigRequest, ObjectStorageWIFConfig>;
    /**
     * Creates or replaces the organization's WIF configuration.
     * Derives org_id from the authenticated caller.
     * Since there is one config per org, this is an idempotent upsert.
     *
     * @generated from protobuf rpc: SetObjectStorageWIFConfig
     */
    setObjectStorageWIFConfig(input: SetObjectStorageWIFConfigRequest, options?: RpcOptions): UnaryCall<SetObjectStorageWIFConfigRequest, ObjectStorageWIFConfig>;
    /**
     * Deletes the organization's WIF configuration.
     * Running sandboxes are unaffected until their OIDC JWT expires.
     * New sandbox requests with object_storage_access will be rejected.
     *
     * @generated from protobuf rpc: DeleteObjectStorageWIFConfig
     */
    deleteObjectStorageWIFConfig(input: DeleteObjectStorageWIFConfigRequest, options?: RpcOptions): UnaryCall<DeleteObjectStorageWIFConfigRequest, DeleteObjectStorageWIFConfigResponse>;
}
//# sourceMappingURL=gateway.client.d.ts.map