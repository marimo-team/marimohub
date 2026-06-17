import { ServiceType } from "@protobuf-ts/runtime-rpc";
import type { BinaryWriteOptions } from "@protobuf-ts/runtime";
import type { IBinaryWriter } from "@protobuf-ts/runtime";
import type { BinaryReadOptions } from "@protobuf-ts/runtime";
import type { IBinaryReader } from "@protobuf-ts/runtime";
import type { PartialMessage } from "@protobuf-ts/runtime";
import { MessageType } from "@protobuf-ts/runtime";
import { Timestamp } from "../../../google/protobuf/timestamp.js";
import { SecretStoreReference } from "./secrets.js";
/**
 * MountedFile describes a file injected at container startup time.
 * The mount_path should include the full path including the filename.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.MountedFile
 */
export interface MountedFile {
    /**
     * @generated from protobuf field: string mount_path = 1
     */
    mountPath: string;
    /**
     * @generated from protobuf field: bytes file_content = 2
     */
    fileContent: Uint8Array;
}
/**
 * @generated from protobuf message coreweave.sandbox.v1beta2.GpuRequest
 */
export interface GpuRequest {
    /**
     * @generated from protobuf field: int64 gpu_count = 1
     */
    gpuCount: string;
    /**
     * @generated from protobuf oneof: spec
     */
    spec: {
        oneofKind: "gpuType";
        /**
         * @generated from protobuf field: string gpu_type = 2
         */
        gpuType: string;
    } | {
        oneofKind: "gpuMemoryGb";
        /**
         * @generated from protobuf field: int64 gpu_memory_gb = 3
         */
        gpuMemoryGb: string;
    } | {
        oneofKind: undefined;
    };
}
/**
 * ResourceRequest specifies compute resource requirements for a sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ResourceRequest
 */
export interface ResourceRequest {
    /**
     * @generated from protobuf field: string cpu = 1
     */
    cpu: string;
    /**
     * @generated from protobuf field: string memory = 2
     */
    memory: string;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.GpuRequest gpu = 3
     */
    gpu?: GpuRequest;
}
/**
 * Port defines a port to expose on the container.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.Port
 */
export interface Port {
    /**
     * @generated from protobuf field: int32 container_port = 1
     */
    containerPort: number;
    /**
     * @generated from protobuf field: string name = 2
     */
    name: string;
    /**
     * @generated from protobuf field: string protocol = 3
     */
    protocol: string;
}
/**
 * ServiceConfig defines how to expose container ports as a Kubernetes Service.
 * Service type is controlled by runner operator configuration based on ingress_mode.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ServiceConfig
 */
export interface ServiceConfig {
    /**
     * Ports to expose as a service. If empty, no service will be created.
     * Only ports listed in the payload's ports can be exposed.
     *
     * @generated from protobuf field: repeated int32 exposed_ports = 1
     */
    exposedPorts: number[];
}
/**
 * NetworkOptions defines network configuration options for the sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.NetworkOptions
 */
export interface NetworkOptions {
    /**
     * Ingress mode name configured by runner operator (e.g., "internal", "public", "custom").
     * Empty means no service exposed. Must match a mode in runner's service_exposure_modes.
     *
     * @generated from protobuf field: string ingress_mode = 1
     */
    ingressMode: string;
    /**
     * Which container ports (from request.ports) to expose via K8s Service.
     * Must reference valid port numbers from the ports field.
     *
     * @generated from protobuf field: repeated int32 exposed_ports = 2
     */
    exposedPorts: number[];
    /**
     * Egress mode name configured by runner operator (e.g., "direct", "natgateway").
     * Empty means default egress behavior. Must match a mode in runner's egress_modes.
     *
     * @generated from protobuf field: string egress_mode = 3
     */
    egressMode: string;
}
/**
 * KubernetesSecretSource identifies a specific key within a Kubernetes Secret.
 * Used for runner cluster secrets resolved locally by Runner.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.KubernetesSecretSource
 */
export interface KubernetesSecretSource {
    /**
     * @generated from protobuf field: string secret_name = 1
     */
    secretName: string;
    /**
     * @generated from protobuf field: string secret_key = 2
     */
    secretKey: string;
}
/**
 * RunnerClusterSecretReference describes a runner cluster secret to inject into a sandbox.
 * Distinct from external secret stores (see docs/architecture/secrets-management.md).
 * This mechanism resolves secrets locally on the Runner's cluster — secret values
 * never transit Gateway, only references flow through the hub.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.RunnerClusterSecretReference
 */
export interface RunnerClusterSecretReference {
    /**
     * Source of the secret — cluster-specific.
     *
     * @generated from protobuf oneof: source
     */
    source: {
        oneofKind: "kubernetes";
        /**
         * @generated from protobuf field: coreweave.sandbox.v1beta2.KubernetesSecretSource kubernetes = 1
         */
        kubernetes: KubernetesSecretSource;
    } | {
        oneofKind: undefined;
    };
    /**
     * Target environment variable name for the resolved secret value.
     *
     * @generated from protobuf field: string env_var = 10
     */
    envVar: string;
}
/**
 * TODO: This is not yet implemented, need to think through this implementation a bit more.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.S3Mount
 */
export interface S3Mount {
    /**
     * @generated from protobuf field: string bucket = 1
     */
    bucket: string;
    /**
     * @generated from protobuf field: string directory = 2
     */
    directory: string;
    /**
     * @generated from protobuf field: string mount_path = 3
     */
    mountPath: string;
}
/**
 * FileSystemSnapshotSource identifies an immutable File System Snapshot (FSS)
 * to restore into a sandbox filesystem mount. Empty file_system_snapshot_id
 * means start from an empty scratch filesystem that can be snapshotted later.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.FileSystemSnapshotSource
 */
export interface FileSystemSnapshotSource {
    /**
     * @generated from protobuf field: string file_system_snapshot_id = 1
     */
    fileSystemSnapshotId: string;
}
/**
 * SandboxFileSystemMount describes a scratch filesystem mounted into the
 * sandbox. V1 implements File System Snapshot-backed EmptyDir semantics;
 * live/shared filesystem sources are reserved for a future product shape.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.SandboxFileSystemMount
 */
export interface SandboxFileSystemMount {
    /**
     * @generated from protobuf field: string mount_path = 1
     */
    mountPath: string;
    /**
     * @generated from protobuf field: string size = 2
     */
    size: string;
    /**
     * @generated from protobuf oneof: source
     */
    source: {
        oneofKind: "fileSystemSnapshot";
        /**
         * @generated from protobuf field: coreweave.sandbox.v1beta2.FileSystemSnapshotSource file_system_snapshot = 3
         */
        fileSystemSnapshot: FileSystemSnapshotSource;
    } | {
        oneofKind: undefined;
    };
}
/**
 * ExecPayload describes a command execution inside an existing sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecPayload
 */
export interface ExecPayload {
    /**
     * @generated from protobuf field: string command = 1
     */
    command: string;
    /**
     * @generated from protobuf field: repeated string args = 2
     */
    args: string[];
}
/**
 * ExecResponse is the result of an Exec call.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecResponse
 */
export interface ExecResponse {
    /**
     * @generated from protobuf field: bytes stdout = 1
     */
    stdout: Uint8Array;
    /**
     * @generated from protobuf field: bytes stderr = 2
     */
    stderr: Uint8Array;
    /**
     * @generated from protobuf field: int32 exit_code = 3
     */
    exitCode: number;
    /**
     * @generated from protobuf field: bool stdout_truncated = 4
     */
    stdoutTruncated: boolean;
    /**
     * @generated from protobuf field: bool stderr_truncated = 5
     */
    stderrTruncated: boolean;
    /**
     * @generated from protobuf field: int64 stdout_bytes_produced = 6
     */
    stdoutBytesProduced: string;
    /**
     * @generated from protobuf field: int64 stderr_bytes_produced = 7
     */
    stderrBytesProduced: string;
}
/**
 * ResourceUsage represents current resource usage of a sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ResourceUsage
 */
export interface ResourceUsage {
    /**
     * @generated from protobuf field: int64 cpu_millicores_used = 1
     */
    cpuMillicoresUsed: string;
    /**
     * @generated from protobuf field: int64 memory_mb_used = 2
     */
    memoryMbUsed: string;
    /**
     * @generated from protobuf field: int64 gpu_count_used = 3
     */
    gpuCountUsed: string;
}
/**
 * ObjectStorageAccess describes object storage access to provision for a sandbox.
 * When provided, Gateway mints a per-sandbox OIDC token and Runner injects a credential
 * vending sidecar that exchanges it for temporary S3 credentials.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ObjectStorageAccess
 */
export interface ObjectStorageAccess {
    /**
     * @generated from protobuf field: repeated string buckets = 1
     */
    buckets: string[];
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ObjectStoragePermission permission = 2
     */
    permission: ObjectStoragePermission;
}
/**
 * StartSandboxRequest launches a new sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.StartSandboxRequest
 */
export interface StartSandboxRequest {
    /**
     * @generated from protobuf field: string command = 1
     */
    command: string;
    /**
     * @generated from protobuf field: repeated string args = 2
     */
    args: string[];
    /**
     * @generated from protobuf field: repeated string tags = 3
     */
    tags: string[];
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ResourceRequest resources = 4
     */
    resources?: ResourceRequest;
    /**
     * @generated from protobuf field: string container_image = 5
     */
    containerImage: string;
    /**
     * @generated from protobuf field: map<string, string> environment_variables = 6
     */
    environmentVariables: {
        [key: string]: string;
    };
    /**
     * @generated from protobuf field: repeated coreweave.sandbox.v1beta2.Port ports = 7
     */
    ports: Port[];
    /**
     * @generated from protobuf field: repeated coreweave.sandbox.v1beta2.MountedFile mounted_files = 8
     */
    mountedFiles: MountedFile[];
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.S3Mount s3_mount = 9
     */
    s3Mount?: S3Mount;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.NetworkOptions network = 10
     */
    network?: NetworkOptions;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.SandboxFileSystemMount file_system = 11
     */
    fileSystem?: SandboxFileSystemMount;
    /**
     * @generated from protobuf field: repeated string profile_ids = 20
     */
    profileIds: string[];
    /**
     * @generated from protobuf field: repeated string runner_ids = 21
     */
    runnerIds: string[];
    /**
     * @generated from protobuf field: repeated string profile_names = 33
     */
    profileNames: string[];
    /**
     * @generated from protobuf field: int32 max_lifetime_seconds = 22
     */
    maxLifetimeSeconds: number;
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 23
     */
    maxTimeoutSeconds: number;
    /**
     * @generated from protobuf field: repeated coreweave.sandbox.v1beta2.RunnerClusterSecretReference runner_cluster_secrets = 24
     */
    runnerClusterSecrets: RunnerClusterSecretReference[];
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ObjectStorageAccess object_storage_access = 25
     */
    objectStorageAccess?: ObjectStorageAccess;
    /**
     * @generated from protobuf field: map<string, string> pod_annotations = 26
     */
    podAnnotations: {
        [key: string]: string;
    };
    /**
     * @generated from protobuf field: repeated coreweave.sandbox.v1beta2.SecretStoreReference secret_stores = 30
     */
    secretStores: SecretStoreReference[];
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ResourceRequest resource_limits = 31
     */
    resourceLimits?: ResourceRequest;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ResourceRequest resource_requests = 32
     */
    resourceRequests?: ResourceRequest;
}
/**
 * StartSandboxResponse returns identifiers and metadata for a started sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.StartSandboxResponse
 */
export interface StartSandboxResponse {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * @generated from protobuf field: google.protobuf.Timestamp started_at_time = 2
     */
    startedAtTime?: Timestamp;
    /**
     * @generated from protobuf field: string service_address = 3
     */
    serviceAddress: string;
    /**
     * @generated from protobuf field: repeated coreweave.sandbox.v1beta2.Port exposed_ports = 4
     */
    exposedPorts: Port[];
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ResourceRequest requested_resources = 5
     */
    requestedResources?: ResourceRequest;
    /**
     * @generated from protobuf field: string profile_id = 6
     */
    profileId: string;
    /**
     * @generated from protobuf field: string runner_id = 7
     */
    runnerId: string;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.SandboxStatus sandbox_status = 8
     */
    sandboxStatus: SandboxStatus;
    /**
     * @generated from protobuf field: string applied_ingress_mode = 9
     */
    appliedIngressMode: string;
    /**
     * @generated from protobuf field: string applied_egress_mode = 10
     */
    appliedEgressMode: string;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ResourceRequest requested_resource_limits = 11
     */
    requestedResourceLimits?: ResourceRequest;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ResourceRequest requested_resource_requests = 12
     */
    requestedResourceRequests?: ResourceRequest;
}
/**
 * StopSandboxRequest terminates a running sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.StopSandboxRequest
 */
export interface StopSandboxRequest {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * @generated from protobuf field: int32 graceful_shutdown_seconds = 2
     */
    gracefulShutdownSeconds: number;
    /**
     * @generated from protobuf field: bool file_system_snapshot_on_stop = 3
     */
    fileSystemSnapshotOnStop: boolean;
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 4
     */
    maxTimeoutSeconds: number;
    /**
     * @generated from protobuf field: string idempotency_key = 5
     */
    idempotencyKey: string;
    /**
     * @generated from protobuf field: optional bool wait_for_ready = 6
     */
    waitForReady?: boolean;
}
/**
 * StopSandboxResponse indicates success or failure of stopping a sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.StopSandboxResponse
 */
export interface StopSandboxResponse {
    /**
     * @generated from protobuf field: bool success = 1
     */
    success: boolean;
    /**
     * @generated from protobuf field: string error_message = 2
     */
    errorMessage: string;
    /**
     * @generated from protobuf field: string file_system_snapshot_id = 3
     */
    fileSystemSnapshotId: string;
}
/**
 * CreateFileSystemSnapshotRequest creates an FSS from a running sandbox without
 * stopping the sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.CreateFileSystemSnapshotRequest
 */
export interface CreateFileSystemSnapshotRequest {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * @generated from protobuf field: string idempotency_key = 2
     */
    idempotencyKey: string;
    /**
     * @generated from protobuf field: optional bool wait_for_ready = 3
     */
    waitForReady?: boolean;
    /**
     * @generated from protobuf field: optional int32 max_timeout_seconds = 4
     */
    maxTimeoutSeconds?: number;
}
/**
 * CreateFileSystemSnapshotResponse indicates success or failure of a mid-life
 * FSS request.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.CreateFileSystemSnapshotResponse
 */
export interface CreateFileSystemSnapshotResponse {
    /**
     * @generated from protobuf field: bool success = 1
     */
    success: boolean;
    /**
     * @generated from protobuf field: string error_message = 2
     */
    errorMessage: string;
    /**
     * @generated from protobuf field: string file_system_snapshot_id = 3
     */
    fileSystemSnapshotId: string;
}
/**
 * FileSystemSnapshot is an immutable, org-scoped snapshot of a sandbox
 * filesystem mount.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.FileSystemSnapshot
 */
export interface FileSystemSnapshot {
    /**
     * @generated from protobuf field: string file_system_snapshot_id = 1
     */
    fileSystemSnapshotId: string;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.FileSystemSnapshotStatus status = 2
     */
    status: FileSystemSnapshotStatus;
    /**
     * @generated from protobuf field: string status_reason = 3
     */
    statusReason: string;
    /**
     * @generated from protobuf field: int64 size_bytes = 4
     */
    sizeBytes: string;
    /**
     * @generated from protobuf field: google.protobuf.Timestamp created_at = 5
     */
    createdAt?: Timestamp;
    /**
     * @generated from protobuf field: google.protobuf.Timestamp updated_at = 6
     */
    updatedAt?: Timestamp;
    /**
     * @generated from protobuf field: google.protobuf.Timestamp completed_at = 7
     */
    completedAt?: Timestamp;
    /**
     * @generated from protobuf field: string source_sandbox_id = 8
     */
    sourceSandboxId: string;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.FileSystemSnapshotTrigger trigger = 9
     */
    trigger: FileSystemSnapshotTrigger;
    /**
     * @generated from protobuf field: string idempotency_key = 10
     */
    idempotencyKey: string;
}
/**
 * GetFileSystemSnapshotRequest gets an org-scoped FSS by id.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.GetFileSystemSnapshotRequest
 */
export interface GetFileSystemSnapshotRequest {
    /**
     * @generated from protobuf field: string file_system_snapshot_id = 1
     */
    fileSystemSnapshotId: string;
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 2
     */
    maxTimeoutSeconds: number;
}
/**
 * ListFileSystemSnapshotsRequest lists org-scoped FSS rows.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ListFileSystemSnapshotsRequest
 */
export interface ListFileSystemSnapshotsRequest {
    /**
     * @generated from protobuf field: int32 page_size = 1
     */
    pageSize: number;
    /**
     * @generated from protobuf field: string page_token = 2
     */
    pageToken: string;
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 3
     */
    maxTimeoutSeconds: number;
}
/**
 * ListFileSystemSnapshotsResponse returns a page of FSS rows.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ListFileSystemSnapshotsResponse
 */
export interface ListFileSystemSnapshotsResponse {
    /**
     * @generated from protobuf field: repeated coreweave.sandbox.v1beta2.FileSystemSnapshot file_system_snapshots = 1
     */
    fileSystemSnapshots: FileSystemSnapshot[];
    /**
     * @generated from protobuf field: string next_page_token = 2
     */
    nextPageToken: string;
}
/**
 * DeleteFileSystemSnapshotRequest hides an org-scoped FSS row from customer
 * Get/List results. It does not stop or delete sandboxes restored from the FSS.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.DeleteFileSystemSnapshotRequest
 */
export interface DeleteFileSystemSnapshotRequest {
    /**
     * @generated from protobuf field: string file_system_snapshot_id = 1
     */
    fileSystemSnapshotId: string;
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 2
     */
    maxTimeoutSeconds: number;
}
/**
 * DeleteFileSystemSnapshotResponse indicates success or failure.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.DeleteFileSystemSnapshotResponse
 */
export interface DeleteFileSystemSnapshotResponse {
    /**
     * @generated from protobuf field: bool success = 1
     */
    success: boolean;
    /**
     * @generated from protobuf field: string error_message = 2
     */
    errorMessage: string;
}
/**
 * GetSandboxRequest gets details about a specific sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.GetSandboxRequest
 */
export interface GetSandboxRequest {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 2
     */
    maxTimeoutSeconds: number;
}
/**
 * GetSandboxResponse returns details about a sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.GetSandboxResponse
 */
export interface GetSandboxResponse {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * @generated from protobuf field: google.protobuf.Timestamp started_at_time = 2
     */
    startedAtTime?: Timestamp;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.SandboxStatus sandbox_status = 3
     */
    sandboxStatus: SandboxStatus;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ResourceUsage current_resource_usage = 4
     */
    currentResourceUsage?: ResourceUsage;
    /**
     * @generated from protobuf field: string runner_id = 5
     */
    runnerId: string;
    /**
     * @generated from protobuf field: string runner_group_id = 6
     */
    runnerGroupId: string;
    /**
     * @generated from protobuf field: string profile_id = 7
     */
    profileId: string;
    /**
     * @generated from protobuf field: string service_address = 8
     */
    serviceAddress: string;
    /**
     * @generated from protobuf field: repeated coreweave.sandbox.v1beta2.Port exposed_ports = 9
     */
    exposedPorts: Port[];
    /**
     * @generated from protobuf field: string applied_ingress_mode = 10
     */
    appliedIngressMode: string;
    /**
     * @generated from protobuf field: string applied_egress_mode = 11
     */
    appliedEgressMode: string;
    /**
     * The reason recorded for the most recent status transition. Populated for
     * terminal statuses (FAILED, COMPLETED, TERMINATED) so clients can surface
     * why a sandbox finished without a separate API call. Empty for sandboxes
     * still running normally.
     *
     * @generated from protobuf field: string status_reason = 12
     */
    statusReason: string;
}
/**
 * ListSandboxesRequest lists sandboxes with optional filters.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ListSandboxesRequest
 */
export interface ListSandboxesRequest {
    /**
     * @generated from protobuf field: repeated string tags = 1
     */
    tags: string[];
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.SandboxStatus status = 2
     */
    status: SandboxStatus;
    /**
     * @generated from protobuf field: repeated string profile_ids = 3
     */
    profileIds: string[];
    /**
     * @generated from protobuf field: repeated string runner_ids = 4
     */
    runnerIds: string[];
    /**
     * @generated from protobuf field: repeated string profile_names = 7
     */
    profileNames: string[];
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 5
     */
    maxTimeoutSeconds: number;
    /**
     * @generated from protobuf field: bool include_stopped = 6
     */
    includeStopped: boolean;
    /**
     * The maximum number of sandboxes to return. If unspecified (0), the server
     * uses a legacy-compatible default of 1000. New callers are encouraged to
     * request 500 or smaller. The server caps at 1000.
     *
     * @generated from protobuf field: int32 page_size = 8
     */
    pageSize: number;
    /**
     * Opaque page token returned by a previous call's next_page_token. Treat as
     * opaque — the encoding may change without notice.
     *
     * @generated from protobuf field: string page_token = 9
     */
    pageToken: string;
}
/**
 * ListSandboxesResponse returns a list of sandboxes.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ListSandboxesResponse
 */
export interface ListSandboxesResponse {
    /**
     * @generated from protobuf field: repeated coreweave.sandbox.v1beta2.SandboxInfo sandboxes = 1
     */
    sandboxes: SandboxInfo[];
    /**
     * Token to pass as page_token in the next request. Empty when there are no
     * more pages.
     *
     * @generated from protobuf field: string next_page_token = 2
     */
    nextPageToken: string;
}
/**
 * SandboxInfo contains basic information about a sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.SandboxInfo
 */
export interface SandboxInfo {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * @generated from protobuf field: google.protobuf.Timestamp started_at_time = 2
     */
    startedAtTime?: Timestamp;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.SandboxStatus sandbox_status = 3
     */
    sandboxStatus: SandboxStatus;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ResourceUsage current_resource_usage = 4
     */
    currentResourceUsage?: ResourceUsage;
    /**
     * @generated from protobuf field: string runner_id = 5
     */
    runnerId: string;
    /**
     * @generated from protobuf field: string runner_group_id = 6
     */
    runnerGroupId: string;
    /**
     * @generated from protobuf field: string profile_id = 7
     */
    profileId: string;
    /**
     * @generated from protobuf field: string service_address = 8
     */
    serviceAddress: string;
    /**
     * @generated from protobuf field: repeated coreweave.sandbox.v1beta2.Port exposed_ports = 9
     */
    exposedPorts: Port[];
    /**
     * @generated from protobuf field: string applied_ingress_mode = 10
     */
    appliedIngressMode: string;
    /**
     * @generated from protobuf field: string applied_egress_mode = 11
     */
    appliedEgressMode: string;
}
/**
 * DeleteSandboxRequest deletes a sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.DeleteSandboxRequest
 */
export interface DeleteSandboxRequest {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 2
     */
    maxTimeoutSeconds: number;
}
/**
 * DeleteSandboxResponse indicates success or failure of deletion.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.DeleteSandboxResponse
 */
export interface DeleteSandboxResponse {
    /**
     * @generated from protobuf field: bool success = 1
     */
    success: boolean;
    /**
     * @generated from protobuf field: string error_message = 2
     */
    errorMessage: string;
}
/**
 * ExecSandboxRequest executes a command within a sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecSandboxRequest
 */
export interface ExecSandboxRequest {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * @generated from protobuf field: repeated string command = 2
     */
    command: string[];
    /**
     * @generated from protobuf field: repeated string args = 3
     */
    args: string[];
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 4
     */
    maxTimeoutSeconds: number;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.OutputPolicy output_handling = 5
     */
    outputHandling: OutputPolicy;
    /**
     * @generated from protobuf field: uint32 buffered_max_kib = 6
     */
    bufferedMaxKib: number;
}
/**
 * ExecSandboxResponse returns command output.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ExecSandboxResponse
 */
export interface ExecSandboxResponse {
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ExecResponse result = 1
     */
    result?: ExecResponse;
}
/**
 * AddFileSandboxRequest writes (or overwrites) a file inside the sandbox filesystem.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.AddFileSandboxRequest
 */
export interface AddFileSandboxRequest {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * File contents to write. An empty value is valid and creates a zero-byte file.
     *
     * @generated from protobuf field: bytes file_contents = 2
     */
    fileContents: Uint8Array;
    /**
     * @generated from protobuf field: string filepath = 3
     */
    filepath: string;
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 4
     */
    maxTimeoutSeconds: number;
}
/**
 * AddFileSandboxResponse indicates success or failure.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.AddFileSandboxResponse
 */
export interface AddFileSandboxResponse {
    /**
     * @generated from protobuf field: bool success = 1
     */
    success: boolean;
    /**
     * @generated from protobuf field: string error_message = 2
     */
    errorMessage: string;
}
/**
 * RetrieveFileSandboxRequest retrieves a file's contents from the sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.RetrieveFileSandboxRequest
 */
export interface RetrieveFileSandboxRequest {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * @generated from protobuf field: string filepath = 2
     */
    filepath: string;
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 3
     */
    maxTimeoutSeconds: number;
}
/**
 * RetrieveFileSandboxResponse returns file contents.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.RetrieveFileSandboxResponse
 */
export interface RetrieveFileSandboxResponse {
    /**
     * @generated from protobuf field: bytes file_contents = 1
     */
    fileContents: Uint8Array;
    /**
     * @generated from protobuf field: bool success = 2
     */
    success: boolean;
    /**
     * @generated from protobuf field: string error_message = 3
     */
    errorMessage: string;
}
/**
 * PauseSandboxRequest pauses a running sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.PauseSandboxRequest
 */
export interface PauseSandboxRequest {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 2
     */
    maxTimeoutSeconds: number;
}
/**
 * PauseSandboxResponse indicates success or failure.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.PauseSandboxResponse
 */
export interface PauseSandboxResponse {
    /**
     * @generated from protobuf field: bool success = 1
     */
    success: boolean;
    /**
     * @generated from protobuf field: string error_message = 2
     */
    errorMessage: string;
}
/**
 * ResumeSandboxRequest resumes a paused sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ResumeSandboxRequest
 */
export interface ResumeSandboxRequest {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 2
     */
    maxTimeoutSeconds: number;
}
/**
 * ResumeSandboxResponse indicates success or failure.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ResumeSandboxResponse
 */
export interface ResumeSandboxResponse {
    /**
     * @generated from protobuf field: bool success = 1
     */
    success: boolean;
    /**
     * @generated from protobuf field: string error_message = 2
     */
    errorMessage: string;
}
/**
 * RawSandboxRequest executes a raw action on a sandbox.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.RawSandboxRequest
 */
export interface RawSandboxRequest {
    /**
     * @generated from protobuf field: string sandbox_id = 1
     */
    sandboxId: string;
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ActionType action_type = 2
     */
    actionType: ActionType;
    /**
     * @generated from protobuf oneof: action_payload
     */
    actionPayload: {
        oneofKind: "execPayload";
        /**
         * @generated from protobuf field: coreweave.sandbox.v1beta2.ExecPayload exec_payload = 3
         */
        execPayload: ExecPayload;
    } | {
        oneofKind: "addFilePayload";
        /**
         * @generated from protobuf field: coreweave.sandbox.v1beta2.AddFileSandboxRequest add_file_payload = 4
         */
        addFilePayload: AddFileSandboxRequest;
    } | {
        oneofKind: "retrieveFilePayload";
        /**
         * @generated from protobuf field: coreweave.sandbox.v1beta2.RetrieveFileSandboxRequest retrieve_file_payload = 5
         */
        retrieveFilePayload: RetrieveFileSandboxRequest;
    } | {
        oneofKind: undefined;
    };
    /**
     * @generated from protobuf field: int32 max_timeout_seconds = 6
     */
    maxTimeoutSeconds: number;
}
/**
 * RawSandboxResponse returns the result of a raw action.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.RawSandboxResponse
 */
export interface RawSandboxResponse {
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ActionType action_type = 1
     */
    actionType: ActionType;
    /**
     * @generated from protobuf oneof: action_response
     */
    actionResponse: {
        oneofKind: "execResponse";
        /**
         * @generated from protobuf field: coreweave.sandbox.v1beta2.ExecSandboxResponse exec_response = 2
         */
        execResponse: ExecSandboxResponse;
    } | {
        oneofKind: "addFileResponse";
        /**
         * @generated from protobuf field: coreweave.sandbox.v1beta2.AddFileSandboxResponse add_file_response = 3
         */
        addFileResponse: AddFileSandboxResponse;
    } | {
        oneofKind: "retrieveFileResponse";
        /**
         * @generated from protobuf field: coreweave.sandbox.v1beta2.RetrieveFileSandboxResponse retrieve_file_response = 4
         */
        retrieveFileResponse: RetrieveFileSandboxResponse;
    } | {
        oneofKind: undefined;
    };
}
/**
 * The WIF configuration for an organization's object storage access.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ObjectStorageWIFConfig
 */
export interface ObjectStorageWIFConfig {
    /**
     * Server-assigned unique identifier.
     *
     * @generated from protobuf field: string id = 1
     */
    id: string;
    /**
     * The WIF config ID from CoreWeave Cloud Console.
     * Obtained by creating a Workload Federation configuration in the Console.
     *
     * @generated from protobuf field: string wif_config_id = 2
     */
    wifConfigId: string;
    /**
     * Whether object storage access is enabled for this organization.
     * When omitted in a Set request, defaults to true (enabled).
     *
     * @generated from protobuf field: optional bool enabled = 3
     */
    enabled?: boolean;
    /**
     * Bucket names the organization is allowed to access.
     * Empty means all buckets are allowed.
     *
     * @generated from protobuf field: repeated string allowed_buckets = 4
     */
    allowedBuckets: string[];
    /**
     * Maximum permission level for sandboxes.
     *
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ObjectStoragePermission max_permission = 5
     */
    maxPermission: ObjectStoragePermission;
    /**
     * Server-assigned timestamps.
     *
     * @generated from protobuf field: google.protobuf.Timestamp created_at = 6
     */
    createdAt?: Timestamp;
    /**
     * @generated from protobuf field: google.protobuf.Timestamp updated_at = 7
     */
    updatedAt?: Timestamp;
}
/**
 * No fields — org_id is derived from auth context.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.GetObjectStorageWIFConfigRequest
 */
export interface GetObjectStorageWIFConfigRequest {
}
/**
 * @generated from protobuf message coreweave.sandbox.v1beta2.SetObjectStorageWIFConfigRequest
 */
export interface SetObjectStorageWIFConfigRequest {
    /**
     * The WIF config ID from CoreWeave Cloud Console.
     *
     * @generated from protobuf field: string wif_config_id = 1
     */
    wifConfigId: string;
    /**
     * Whether object storage access is enabled.
     * When omitted, defaults to true (enabled). Use `false` to explicitly disable.
     *
     * @generated from protobuf field: optional bool enabled = 2
     */
    enabled?: boolean;
    /**
     * Bucket names the organization is allowed to access.
     * Empty list means all buckets are allowed.
     *
     * @generated from protobuf field: repeated string allowed_buckets = 3
     */
    allowedBuckets: string[];
    /**
     * Maximum permission level for sandboxes. Must be READ or READ_WRITE.
     *
     * @generated from protobuf field: coreweave.sandbox.v1beta2.ObjectStoragePermission max_permission = 4
     */
    maxPermission: ObjectStoragePermission;
}
/**
 * No fields — org_id is derived from auth context.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.DeleteObjectStorageWIFConfigRequest
 */
export interface DeleteObjectStorageWIFConfigRequest {
}
/**
 * Empty — successful deletion returns no content.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.DeleteObjectStorageWIFConfigResponse
 */
export interface DeleteObjectStorageWIFConfigResponse {
}
/**
 * OutputPolicy selects how exec output is returned.
 *
 * @generated from protobuf enum coreweave.sandbox.v1beta2.OutputPolicy
 */
export declare enum OutputPolicy {
    /**
     * Treated as BUFFERED with the server default cap.
     *
     * @generated from protobuf enum value: OUTPUT_POLICY_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * Unary response; truncated when output exceeds the cap.
     *
     * @generated from protobuf enum value: OUTPUT_POLICY_BUFFERED = 1;
     */
    BUFFERED = 1,
    /**
     * Bidi stream; full output delivered in chunks.
     *
     * @generated from protobuf enum value: OUTPUT_POLICY_STREAM = 2;
     */
    STREAM = 2,
    /**
     * Output dropped; exit_code and timing still returned.
     *
     * @generated from protobuf enum value: OUTPUT_POLICY_DISCARD = 3;
     */
    DISCARD = 3
}
/**
 * SandboxStatus represents the high-level lifecycle state of a sandbox.
 *
 * Lifecycle: CREATING → RUNNING → TERMINATING → COMPLETED | FAILED
 *
 * TERMINATING is a non-terminal intermediate state indicating the sandbox
 * is being torn down (pod has DeletionTimestamp, draining through grace
 * period). The workload routing key and cache metadata remain alive so
 * the Get path can still query the runner for real-time status.
 *
 * @generated from protobuf enum coreweave.sandbox.v1beta2.SandboxStatus
 */
export declare enum SandboxStatus {
    /**
     * State is unknown / not yet determined
     *
     * @generated from protobuf enum value: SANDBOX_STATUS_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * Being provisioned / started
     *
     * @generated from protobuf enum value: SANDBOX_STATUS_CREATING = 1;
     */
    CREATING = 1,
    /**
     * Actively running
     *
     * @generated from protobuf enum value: SANDBOX_STATUS_RUNNING = 2;
     */
    RUNNING = 2,
    /**
     * Finished successfully
     *
     * @generated from protobuf enum value: SANDBOX_STATUS_COMPLETED = 3;
     */
    COMPLETED = 3,
    /**
     * Failed during creation or execution
     *
     * @generated from protobuf enum value: SANDBOX_STATUS_FAILED = 4;
     */
    FAILED = 4,
    /**
     * Deprecated: use TERMINATING (non-terminal) or COMPLETED/FAILED (terminal)
     *
     * @deprecated
     * @generated from protobuf enum value: SANDBOX_STATUS_TERMINATED = 5 [deprecated = true];
     */
    TERMINATED = 5,
    /**
     * Pending assignment within a given compute cluster
     *
     * @generated from protobuf enum value: SANDBOX_STATUS_PENDING = 6;
     */
    PENDING = 6,
    /**
     * Paused state
     *
     * @generated from protobuf enum value: SANDBOX_STATUS_PAUSED = 7;
     */
    PAUSED = 7,
    /**
     * Being torn down — pod is draining (non-terminal)
     *
     * @generated from protobuf enum value: SANDBOX_STATUS_TERMINATING = 9;
     */
    TERMINATING = 9
}
/**
 * FileSystemSnapshotStatus represents the lifecycle state of an immutable FSS.
 *
 * @generated from protobuf enum coreweave.sandbox.v1beta2.FileSystemSnapshotStatus
 */
export declare enum FileSystemSnapshotStatus {
    /**
     * @generated from protobuf enum value: FILE_SYSTEM_SNAPSHOT_STATUS_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from protobuf enum value: FILE_SYSTEM_SNAPSHOT_STATUS_CREATING = 1;
     */
    CREATING = 1,
    /**
     * @generated from protobuf enum value: FILE_SYSTEM_SNAPSHOT_STATUS_READY = 2;
     */
    READY = 2,
    /**
     * @generated from protobuf enum value: FILE_SYSTEM_SNAPSHOT_STATUS_FAILED = 3;
     */
    FAILED = 3,
    /**
     * @generated from protobuf enum value: FILE_SYSTEM_SNAPSHOT_STATUS_DELETING = 4;
     */
    DELETING = 4
}
/**
 * FileSystemSnapshotTrigger identifies which API path created an FSS row.
 *
 * @generated from protobuf enum coreweave.sandbox.v1beta2.FileSystemSnapshotTrigger
 */
export declare enum FileSystemSnapshotTrigger {
    /**
     * @generated from protobuf enum value: FILE_SYSTEM_SNAPSHOT_TRIGGER_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from protobuf enum value: FILE_SYSTEM_SNAPSHOT_TRIGGER_STOP = 1;
     */
    STOP = 1,
    /**
     * @generated from protobuf enum value: FILE_SYSTEM_SNAPSHOT_TRIGGER_MANUAL = 2;
     */
    MANUAL = 2
}
/**
 * ActionType enumerates supported raw action types that can be executed on a sandbox.
 *
 * @generated from protobuf enum coreweave.sandbox.v1beta2.ActionType
 */
export declare enum ActionType {
    /**
     * @generated from protobuf enum value: ACTION_TYPE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from protobuf enum value: ACTION_TYPE_EXEC = 1;
     */
    EXEC = 1,
    /**
     * @generated from protobuf enum value: ACTION_TYPE_ADD_FILE = 2;
     */
    ADD_FILE = 2,
    /**
     * @generated from protobuf enum value: ACTION_TYPE_RETRIEVE_FILE = 3;
     */
    RETRIEVE_FILE = 3,
    /**
     * @generated from protobuf enum value: ACTION_TYPE_GET_LOGS = 4;
     */
    GET_LOGS = 4,
    /**
     * @generated from protobuf enum value: ACTION_TYPE_SNAPSHOT = 5;
     */
    SNAPSHOT = 5,
    /**
     * @generated from protobuf enum value: ACTION_TYPE_RESTORE = 6;
     */
    RESTORE = 6,
    /**
     * @generated from protobuf enum value: ACTION_TYPE_STATUS = 7;
     */
    STATUS = 7,
    /**
     * @generated from protobuf enum value: ACTION_TYPE_STOP = 8;
     */
    STOP = 8
}
/**
 * EgressType determines how egress traffic is allowed for sandboxes.
 * Maps to pkg.EgressType Go constants.
 *
 * @generated from protobuf enum coreweave.sandbox.v1beta2.EgressType
 */
export declare enum EgressType {
    /**
     * @generated from protobuf enum value: EGRESS_TYPE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from protobuf enum value: EGRESS_TYPE_NONE = 1;
     */
    NONE = 1,
    /**
     * @generated from protobuf enum value: EGRESS_TYPE_INTERNET = 2;
     */
    INTERNET = 2,
    /**
     * @generated from protobuf enum value: EGRESS_TYPE_USER = 3;
     */
    USER = 3,
    /**
     * @generated from protobuf enum value: EGRESS_TYPE_ORG = 4;
     */
    ORG = 4,
    /**
     * @generated from protobuf enum value: EGRESS_TYPE_RUNWAY = 5;
     */
    RUNWAY = 5,
    /**
     * @generated from protobuf enum value: EGRESS_TYPE_ALLOWLIST = 6;
     */
    ALLOWLIST = 6
}
/**
 * ObjectStoragePermission specifies the access level for object storage buckets.
 *
 * @generated from protobuf enum coreweave.sandbox.v1beta2.ObjectStoragePermission
 */
export declare enum ObjectStoragePermission {
    /**
     * @generated from protobuf enum value: OBJECT_STORAGE_PERMISSION_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from protobuf enum value: OBJECT_STORAGE_PERMISSION_READ = 1;
     */
    READ = 1,
    /**
     * @generated from protobuf enum value: OBJECT_STORAGE_PERMISSION_READ_WRITE = 2;
     */
    READ_WRITE = 2
}
declare class MountedFile$Type extends MessageType<MountedFile> {
    constructor();
    create(value?: PartialMessage<MountedFile>): MountedFile;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: MountedFile): MountedFile;
    internalBinaryWrite(message: MountedFile, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.MountedFile
 */
export declare const MountedFile: MountedFile$Type;
declare class GpuRequest$Type extends MessageType<GpuRequest> {
    constructor();
    create(value?: PartialMessage<GpuRequest>): GpuRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: GpuRequest): GpuRequest;
    internalBinaryWrite(message: GpuRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.GpuRequest
 */
export declare const GpuRequest: GpuRequest$Type;
declare class ResourceRequest$Type extends MessageType<ResourceRequest> {
    constructor();
    create(value?: PartialMessage<ResourceRequest>): ResourceRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ResourceRequest): ResourceRequest;
    internalBinaryWrite(message: ResourceRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ResourceRequest
 */
export declare const ResourceRequest: ResourceRequest$Type;
declare class Port$Type extends MessageType<Port> {
    constructor();
    create(value?: PartialMessage<Port>): Port;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: Port): Port;
    internalBinaryWrite(message: Port, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.Port
 */
export declare const Port: Port$Type;
declare class ServiceConfig$Type extends MessageType<ServiceConfig> {
    constructor();
    create(value?: PartialMessage<ServiceConfig>): ServiceConfig;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ServiceConfig): ServiceConfig;
    internalBinaryWrite(message: ServiceConfig, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ServiceConfig
 */
export declare const ServiceConfig: ServiceConfig$Type;
declare class NetworkOptions$Type extends MessageType<NetworkOptions> {
    constructor();
    create(value?: PartialMessage<NetworkOptions>): NetworkOptions;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: NetworkOptions): NetworkOptions;
    internalBinaryWrite(message: NetworkOptions, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.NetworkOptions
 */
export declare const NetworkOptions: NetworkOptions$Type;
declare class KubernetesSecretSource$Type extends MessageType<KubernetesSecretSource> {
    constructor();
    create(value?: PartialMessage<KubernetesSecretSource>): KubernetesSecretSource;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: KubernetesSecretSource): KubernetesSecretSource;
    internalBinaryWrite(message: KubernetesSecretSource, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.KubernetesSecretSource
 */
export declare const KubernetesSecretSource: KubernetesSecretSource$Type;
declare class RunnerClusterSecretReference$Type extends MessageType<RunnerClusterSecretReference> {
    constructor();
    create(value?: PartialMessage<RunnerClusterSecretReference>): RunnerClusterSecretReference;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: RunnerClusterSecretReference): RunnerClusterSecretReference;
    internalBinaryWrite(message: RunnerClusterSecretReference, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.RunnerClusterSecretReference
 */
export declare const RunnerClusterSecretReference: RunnerClusterSecretReference$Type;
declare class S3Mount$Type extends MessageType<S3Mount> {
    constructor();
    create(value?: PartialMessage<S3Mount>): S3Mount;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: S3Mount): S3Mount;
    internalBinaryWrite(message: S3Mount, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.S3Mount
 */
export declare const S3Mount: S3Mount$Type;
declare class FileSystemSnapshotSource$Type extends MessageType<FileSystemSnapshotSource> {
    constructor();
    create(value?: PartialMessage<FileSystemSnapshotSource>): FileSystemSnapshotSource;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: FileSystemSnapshotSource): FileSystemSnapshotSource;
    internalBinaryWrite(message: FileSystemSnapshotSource, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.FileSystemSnapshotSource
 */
export declare const FileSystemSnapshotSource: FileSystemSnapshotSource$Type;
declare class SandboxFileSystemMount$Type extends MessageType<SandboxFileSystemMount> {
    constructor();
    create(value?: PartialMessage<SandboxFileSystemMount>): SandboxFileSystemMount;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: SandboxFileSystemMount): SandboxFileSystemMount;
    internalBinaryWrite(message: SandboxFileSystemMount, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.SandboxFileSystemMount
 */
export declare const SandboxFileSystemMount: SandboxFileSystemMount$Type;
declare class ExecPayload$Type extends MessageType<ExecPayload> {
    constructor();
    create(value?: PartialMessage<ExecPayload>): ExecPayload;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecPayload): ExecPayload;
    internalBinaryWrite(message: ExecPayload, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecPayload
 */
export declare const ExecPayload: ExecPayload$Type;
declare class ExecResponse$Type extends MessageType<ExecResponse> {
    constructor();
    create(value?: PartialMessage<ExecResponse>): ExecResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecResponse): ExecResponse;
    internalBinaryWrite(message: ExecResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecResponse
 */
export declare const ExecResponse: ExecResponse$Type;
declare class ResourceUsage$Type extends MessageType<ResourceUsage> {
    constructor();
    create(value?: PartialMessage<ResourceUsage>): ResourceUsage;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ResourceUsage): ResourceUsage;
    internalBinaryWrite(message: ResourceUsage, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ResourceUsage
 */
export declare const ResourceUsage: ResourceUsage$Type;
declare class ObjectStorageAccess$Type extends MessageType<ObjectStorageAccess> {
    constructor();
    create(value?: PartialMessage<ObjectStorageAccess>): ObjectStorageAccess;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ObjectStorageAccess): ObjectStorageAccess;
    internalBinaryWrite(message: ObjectStorageAccess, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ObjectStorageAccess
 */
export declare const ObjectStorageAccess: ObjectStorageAccess$Type;
declare class StartSandboxRequest$Type extends MessageType<StartSandboxRequest> {
    constructor();
    create(value?: PartialMessage<StartSandboxRequest>): StartSandboxRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: StartSandboxRequest): StartSandboxRequest;
    private binaryReadMap6;
    private binaryReadMap26;
    internalBinaryWrite(message: StartSandboxRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.StartSandboxRequest
 */
export declare const StartSandboxRequest: StartSandboxRequest$Type;
declare class StartSandboxResponse$Type extends MessageType<StartSandboxResponse> {
    constructor();
    create(value?: PartialMessage<StartSandboxResponse>): StartSandboxResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: StartSandboxResponse): StartSandboxResponse;
    internalBinaryWrite(message: StartSandboxResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.StartSandboxResponse
 */
export declare const StartSandboxResponse: StartSandboxResponse$Type;
declare class StopSandboxRequest$Type extends MessageType<StopSandboxRequest> {
    constructor();
    create(value?: PartialMessage<StopSandboxRequest>): StopSandboxRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: StopSandboxRequest): StopSandboxRequest;
    internalBinaryWrite(message: StopSandboxRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.StopSandboxRequest
 */
export declare const StopSandboxRequest: StopSandboxRequest$Type;
declare class StopSandboxResponse$Type extends MessageType<StopSandboxResponse> {
    constructor();
    create(value?: PartialMessage<StopSandboxResponse>): StopSandboxResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: StopSandboxResponse): StopSandboxResponse;
    internalBinaryWrite(message: StopSandboxResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.StopSandboxResponse
 */
export declare const StopSandboxResponse: StopSandboxResponse$Type;
declare class CreateFileSystemSnapshotRequest$Type extends MessageType<CreateFileSystemSnapshotRequest> {
    constructor();
    create(value?: PartialMessage<CreateFileSystemSnapshotRequest>): CreateFileSystemSnapshotRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: CreateFileSystemSnapshotRequest): CreateFileSystemSnapshotRequest;
    internalBinaryWrite(message: CreateFileSystemSnapshotRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.CreateFileSystemSnapshotRequest
 */
export declare const CreateFileSystemSnapshotRequest: CreateFileSystemSnapshotRequest$Type;
declare class CreateFileSystemSnapshotResponse$Type extends MessageType<CreateFileSystemSnapshotResponse> {
    constructor();
    create(value?: PartialMessage<CreateFileSystemSnapshotResponse>): CreateFileSystemSnapshotResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: CreateFileSystemSnapshotResponse): CreateFileSystemSnapshotResponse;
    internalBinaryWrite(message: CreateFileSystemSnapshotResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.CreateFileSystemSnapshotResponse
 */
export declare const CreateFileSystemSnapshotResponse: CreateFileSystemSnapshotResponse$Type;
declare class FileSystemSnapshot$Type extends MessageType<FileSystemSnapshot> {
    constructor();
    create(value?: PartialMessage<FileSystemSnapshot>): FileSystemSnapshot;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: FileSystemSnapshot): FileSystemSnapshot;
    internalBinaryWrite(message: FileSystemSnapshot, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.FileSystemSnapshot
 */
export declare const FileSystemSnapshot: FileSystemSnapshot$Type;
declare class GetFileSystemSnapshotRequest$Type extends MessageType<GetFileSystemSnapshotRequest> {
    constructor();
    create(value?: PartialMessage<GetFileSystemSnapshotRequest>): GetFileSystemSnapshotRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: GetFileSystemSnapshotRequest): GetFileSystemSnapshotRequest;
    internalBinaryWrite(message: GetFileSystemSnapshotRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.GetFileSystemSnapshotRequest
 */
export declare const GetFileSystemSnapshotRequest: GetFileSystemSnapshotRequest$Type;
declare class ListFileSystemSnapshotsRequest$Type extends MessageType<ListFileSystemSnapshotsRequest> {
    constructor();
    create(value?: PartialMessage<ListFileSystemSnapshotsRequest>): ListFileSystemSnapshotsRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ListFileSystemSnapshotsRequest): ListFileSystemSnapshotsRequest;
    internalBinaryWrite(message: ListFileSystemSnapshotsRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ListFileSystemSnapshotsRequest
 */
export declare const ListFileSystemSnapshotsRequest: ListFileSystemSnapshotsRequest$Type;
declare class ListFileSystemSnapshotsResponse$Type extends MessageType<ListFileSystemSnapshotsResponse> {
    constructor();
    create(value?: PartialMessage<ListFileSystemSnapshotsResponse>): ListFileSystemSnapshotsResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ListFileSystemSnapshotsResponse): ListFileSystemSnapshotsResponse;
    internalBinaryWrite(message: ListFileSystemSnapshotsResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ListFileSystemSnapshotsResponse
 */
export declare const ListFileSystemSnapshotsResponse: ListFileSystemSnapshotsResponse$Type;
declare class DeleteFileSystemSnapshotRequest$Type extends MessageType<DeleteFileSystemSnapshotRequest> {
    constructor();
    create(value?: PartialMessage<DeleteFileSystemSnapshotRequest>): DeleteFileSystemSnapshotRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: DeleteFileSystemSnapshotRequest): DeleteFileSystemSnapshotRequest;
    internalBinaryWrite(message: DeleteFileSystemSnapshotRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.DeleteFileSystemSnapshotRequest
 */
export declare const DeleteFileSystemSnapshotRequest: DeleteFileSystemSnapshotRequest$Type;
declare class DeleteFileSystemSnapshotResponse$Type extends MessageType<DeleteFileSystemSnapshotResponse> {
    constructor();
    create(value?: PartialMessage<DeleteFileSystemSnapshotResponse>): DeleteFileSystemSnapshotResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: DeleteFileSystemSnapshotResponse): DeleteFileSystemSnapshotResponse;
    internalBinaryWrite(message: DeleteFileSystemSnapshotResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.DeleteFileSystemSnapshotResponse
 */
export declare const DeleteFileSystemSnapshotResponse: DeleteFileSystemSnapshotResponse$Type;
declare class GetSandboxRequest$Type extends MessageType<GetSandboxRequest> {
    constructor();
    create(value?: PartialMessage<GetSandboxRequest>): GetSandboxRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: GetSandboxRequest): GetSandboxRequest;
    internalBinaryWrite(message: GetSandboxRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.GetSandboxRequest
 */
export declare const GetSandboxRequest: GetSandboxRequest$Type;
declare class GetSandboxResponse$Type extends MessageType<GetSandboxResponse> {
    constructor();
    create(value?: PartialMessage<GetSandboxResponse>): GetSandboxResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: GetSandboxResponse): GetSandboxResponse;
    internalBinaryWrite(message: GetSandboxResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.GetSandboxResponse
 */
export declare const GetSandboxResponse: GetSandboxResponse$Type;
declare class ListSandboxesRequest$Type extends MessageType<ListSandboxesRequest> {
    constructor();
    create(value?: PartialMessage<ListSandboxesRequest>): ListSandboxesRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ListSandboxesRequest): ListSandboxesRequest;
    internalBinaryWrite(message: ListSandboxesRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ListSandboxesRequest
 */
export declare const ListSandboxesRequest: ListSandboxesRequest$Type;
declare class ListSandboxesResponse$Type extends MessageType<ListSandboxesResponse> {
    constructor();
    create(value?: PartialMessage<ListSandboxesResponse>): ListSandboxesResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ListSandboxesResponse): ListSandboxesResponse;
    internalBinaryWrite(message: ListSandboxesResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ListSandboxesResponse
 */
export declare const ListSandboxesResponse: ListSandboxesResponse$Type;
declare class SandboxInfo$Type extends MessageType<SandboxInfo> {
    constructor();
    create(value?: PartialMessage<SandboxInfo>): SandboxInfo;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: SandboxInfo): SandboxInfo;
    internalBinaryWrite(message: SandboxInfo, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.SandboxInfo
 */
export declare const SandboxInfo: SandboxInfo$Type;
declare class DeleteSandboxRequest$Type extends MessageType<DeleteSandboxRequest> {
    constructor();
    create(value?: PartialMessage<DeleteSandboxRequest>): DeleteSandboxRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: DeleteSandboxRequest): DeleteSandboxRequest;
    internalBinaryWrite(message: DeleteSandboxRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.DeleteSandboxRequest
 */
export declare const DeleteSandboxRequest: DeleteSandboxRequest$Type;
declare class DeleteSandboxResponse$Type extends MessageType<DeleteSandboxResponse> {
    constructor();
    create(value?: PartialMessage<DeleteSandboxResponse>): DeleteSandboxResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: DeleteSandboxResponse): DeleteSandboxResponse;
    internalBinaryWrite(message: DeleteSandboxResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.DeleteSandboxResponse
 */
export declare const DeleteSandboxResponse: DeleteSandboxResponse$Type;
declare class ExecSandboxRequest$Type extends MessageType<ExecSandboxRequest> {
    constructor();
    create(value?: PartialMessage<ExecSandboxRequest>): ExecSandboxRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecSandboxRequest): ExecSandboxRequest;
    internalBinaryWrite(message: ExecSandboxRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecSandboxRequest
 */
export declare const ExecSandboxRequest: ExecSandboxRequest$Type;
declare class ExecSandboxResponse$Type extends MessageType<ExecSandboxResponse> {
    constructor();
    create(value?: PartialMessage<ExecSandboxResponse>): ExecSandboxResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ExecSandboxResponse): ExecSandboxResponse;
    internalBinaryWrite(message: ExecSandboxResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ExecSandboxResponse
 */
export declare const ExecSandboxResponse: ExecSandboxResponse$Type;
declare class AddFileSandboxRequest$Type extends MessageType<AddFileSandboxRequest> {
    constructor();
    create(value?: PartialMessage<AddFileSandboxRequest>): AddFileSandboxRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: AddFileSandboxRequest): AddFileSandboxRequest;
    internalBinaryWrite(message: AddFileSandboxRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.AddFileSandboxRequest
 */
export declare const AddFileSandboxRequest: AddFileSandboxRequest$Type;
declare class AddFileSandboxResponse$Type extends MessageType<AddFileSandboxResponse> {
    constructor();
    create(value?: PartialMessage<AddFileSandboxResponse>): AddFileSandboxResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: AddFileSandboxResponse): AddFileSandboxResponse;
    internalBinaryWrite(message: AddFileSandboxResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.AddFileSandboxResponse
 */
export declare const AddFileSandboxResponse: AddFileSandboxResponse$Type;
declare class RetrieveFileSandboxRequest$Type extends MessageType<RetrieveFileSandboxRequest> {
    constructor();
    create(value?: PartialMessage<RetrieveFileSandboxRequest>): RetrieveFileSandboxRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: RetrieveFileSandboxRequest): RetrieveFileSandboxRequest;
    internalBinaryWrite(message: RetrieveFileSandboxRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.RetrieveFileSandboxRequest
 */
export declare const RetrieveFileSandboxRequest: RetrieveFileSandboxRequest$Type;
declare class RetrieveFileSandboxResponse$Type extends MessageType<RetrieveFileSandboxResponse> {
    constructor();
    create(value?: PartialMessage<RetrieveFileSandboxResponse>): RetrieveFileSandboxResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: RetrieveFileSandboxResponse): RetrieveFileSandboxResponse;
    internalBinaryWrite(message: RetrieveFileSandboxResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.RetrieveFileSandboxResponse
 */
export declare const RetrieveFileSandboxResponse: RetrieveFileSandboxResponse$Type;
declare class PauseSandboxRequest$Type extends MessageType<PauseSandboxRequest> {
    constructor();
    create(value?: PartialMessage<PauseSandboxRequest>): PauseSandboxRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: PauseSandboxRequest): PauseSandboxRequest;
    internalBinaryWrite(message: PauseSandboxRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.PauseSandboxRequest
 */
export declare const PauseSandboxRequest: PauseSandboxRequest$Type;
declare class PauseSandboxResponse$Type extends MessageType<PauseSandboxResponse> {
    constructor();
    create(value?: PartialMessage<PauseSandboxResponse>): PauseSandboxResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: PauseSandboxResponse): PauseSandboxResponse;
    internalBinaryWrite(message: PauseSandboxResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.PauseSandboxResponse
 */
export declare const PauseSandboxResponse: PauseSandboxResponse$Type;
declare class ResumeSandboxRequest$Type extends MessageType<ResumeSandboxRequest> {
    constructor();
    create(value?: PartialMessage<ResumeSandboxRequest>): ResumeSandboxRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ResumeSandboxRequest): ResumeSandboxRequest;
    internalBinaryWrite(message: ResumeSandboxRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ResumeSandboxRequest
 */
export declare const ResumeSandboxRequest: ResumeSandboxRequest$Type;
declare class ResumeSandboxResponse$Type extends MessageType<ResumeSandboxResponse> {
    constructor();
    create(value?: PartialMessage<ResumeSandboxResponse>): ResumeSandboxResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ResumeSandboxResponse): ResumeSandboxResponse;
    internalBinaryWrite(message: ResumeSandboxResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ResumeSandboxResponse
 */
export declare const ResumeSandboxResponse: ResumeSandboxResponse$Type;
declare class RawSandboxRequest$Type extends MessageType<RawSandboxRequest> {
    constructor();
    create(value?: PartialMessage<RawSandboxRequest>): RawSandboxRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: RawSandboxRequest): RawSandboxRequest;
    internalBinaryWrite(message: RawSandboxRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.RawSandboxRequest
 */
export declare const RawSandboxRequest: RawSandboxRequest$Type;
declare class RawSandboxResponse$Type extends MessageType<RawSandboxResponse> {
    constructor();
    create(value?: PartialMessage<RawSandboxResponse>): RawSandboxResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: RawSandboxResponse): RawSandboxResponse;
    internalBinaryWrite(message: RawSandboxResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.RawSandboxResponse
 */
export declare const RawSandboxResponse: RawSandboxResponse$Type;
declare class ObjectStorageWIFConfig$Type extends MessageType<ObjectStorageWIFConfig> {
    constructor();
    create(value?: PartialMessage<ObjectStorageWIFConfig>): ObjectStorageWIFConfig;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ObjectStorageWIFConfig): ObjectStorageWIFConfig;
    internalBinaryWrite(message: ObjectStorageWIFConfig, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ObjectStorageWIFConfig
 */
export declare const ObjectStorageWIFConfig: ObjectStorageWIFConfig$Type;
declare class GetObjectStorageWIFConfigRequest$Type extends MessageType<GetObjectStorageWIFConfigRequest> {
    constructor();
    create(value?: PartialMessage<GetObjectStorageWIFConfigRequest>): GetObjectStorageWIFConfigRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: GetObjectStorageWIFConfigRequest): GetObjectStorageWIFConfigRequest;
    internalBinaryWrite(message: GetObjectStorageWIFConfigRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.GetObjectStorageWIFConfigRequest
 */
export declare const GetObjectStorageWIFConfigRequest: GetObjectStorageWIFConfigRequest$Type;
declare class SetObjectStorageWIFConfigRequest$Type extends MessageType<SetObjectStorageWIFConfigRequest> {
    constructor();
    create(value?: PartialMessage<SetObjectStorageWIFConfigRequest>): SetObjectStorageWIFConfigRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: SetObjectStorageWIFConfigRequest): SetObjectStorageWIFConfigRequest;
    internalBinaryWrite(message: SetObjectStorageWIFConfigRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.SetObjectStorageWIFConfigRequest
 */
export declare const SetObjectStorageWIFConfigRequest: SetObjectStorageWIFConfigRequest$Type;
declare class DeleteObjectStorageWIFConfigRequest$Type extends MessageType<DeleteObjectStorageWIFConfigRequest> {
    constructor();
    create(value?: PartialMessage<DeleteObjectStorageWIFConfigRequest>): DeleteObjectStorageWIFConfigRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: DeleteObjectStorageWIFConfigRequest): DeleteObjectStorageWIFConfigRequest;
    internalBinaryWrite(message: DeleteObjectStorageWIFConfigRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.DeleteObjectStorageWIFConfigRequest
 */
export declare const DeleteObjectStorageWIFConfigRequest: DeleteObjectStorageWIFConfigRequest$Type;
declare class DeleteObjectStorageWIFConfigResponse$Type extends MessageType<DeleteObjectStorageWIFConfigResponse> {
    constructor();
    create(value?: PartialMessage<DeleteObjectStorageWIFConfigResponse>): DeleteObjectStorageWIFConfigResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: DeleteObjectStorageWIFConfigResponse): DeleteObjectStorageWIFConfigResponse;
    internalBinaryWrite(message: DeleteObjectStorageWIFConfigResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.DeleteObjectStorageWIFConfigResponse
 */
export declare const DeleteObjectStorageWIFConfigResponse: DeleteObjectStorageWIFConfigResponse$Type;
/**
 * @generated ServiceType for protobuf service coreweave.sandbox.v1beta2.GatewayService
 */
export declare const GatewayService: ServiceType;

//# sourceMappingURL=gateway.d.ts.map