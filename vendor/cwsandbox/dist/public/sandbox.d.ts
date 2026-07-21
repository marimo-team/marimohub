import type { RequestOptions, Seconds } from "./common.js";
import type { MountedFiles } from "./files.js";
import type { NetworkOptions, PortInput } from "./network.js";
import type { ResourceOptions } from "./resources.js";
export type EnvironmentVariables = Readonly<Record<string, string>>;
export type FromIdOptions = RequestOptions;
export type SandboxAnnotations = Readonly<Record<string, string>>;
export type SandboxId = string;
export type SandboxTag = string;
export type SandboxStatus = "pending" | "creating" | "running" | "paused" | "terminating" | "completed" | "failed" | "terminated" | "unspecified";
export interface SandboxObjectStorageAccess {
    readonly buckets: readonly string[];
    readonly permission: "read" | "read-write";
}
export type WaitTargetStatus = "completed" | "paused" | "running";
export interface WaitOptions extends RequestOptions {
    readonly intervalMs?: number;
    readonly targetStatus?: WaitTargetStatus;
}
export interface SandboxRunOptions extends RequestOptions {
    readonly annotations?: SandboxAnnotations;
    readonly containerImage?: string;
    readonly environmentVariables?: EnvironmentVariables;
    readonly maxLifetimeSeconds?: Seconds;
    readonly mountedFiles?: MountedFiles;
    readonly network?: NetworkOptions;
    readonly objectStorageAccess?: SandboxObjectStorageAccess;
    readonly ports?: readonly PortInput[];
    readonly profileIds?: readonly string[];
    readonly profileNames?: readonly string[];
    readonly resources?: ResourceOptions;
    readonly runnerIds?: readonly string[];
    readonly tags?: readonly SandboxTag[];
    /**
     * Wait for the sandbox to reach `running` before resolving creation helpers.
     *
     * Defaults to `true`. Set to `false` only when you need a handle as soon as
     * the backend accepts the start request.
     */
    readonly waitUntilRunning?: boolean;
}
export interface StopOptions extends RequestOptions {
    readonly gracefulShutdownSeconds?: Seconds;
    readonly snapshotOnStop?: boolean;
}
export interface ListSandboxesOptions extends RequestOptions {
    readonly includeStopped?: boolean;
    readonly pageSize?: number;
    readonly pageToken?: string;
    readonly profileIds?: readonly string[];
    readonly profileNames?: readonly string[];
    readonly runnerIds?: readonly string[];
    readonly status?: SandboxStatus;
    readonly tags?: readonly SandboxTag[];
}
export interface SandboxInfo {
    readonly profileId?: string;
    readonly runnerGroupId?: string;
    readonly runnerId?: string;
    readonly sandboxId: SandboxId;
    readonly status: SandboxStatus;
}
export interface ListSandboxesResult {
    readonly nextPageToken?: string;
    readonly sandboxes: readonly SandboxInfo[];
}
export interface StartSandboxResult {
    readonly sandboxId: SandboxId;
    readonly status?: SandboxStatus;
}
export interface GetSandboxResult {
    readonly sandboxId: SandboxId;
    readonly status: SandboxStatus;
    /** External address of the sandbox's exposed service, when the runner assigns one (e.g. the W&B gateway's per-sandbox public IP). */
    readonly serviceAddress?: string;
}
//# sourceMappingURL=sandbox.d.ts.map