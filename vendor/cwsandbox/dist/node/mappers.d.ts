import type { Command, ExecRequest, ListSandboxesOptions, ListSandboxesResult, ProcessResult, SandboxInfo, SandboxStatus, StartSandboxRequest } from "../types.js";
import { SandboxStatus as ProtoSandboxStatus } from "./generated/coreweave/sandbox/v1beta2/gateway.js";
import type { ExecSandboxRequest as ProtoExecSandboxRequest, ExecResponse as ProtoExecResponse, ListSandboxesRequest as ProtoListSandboxesRequest, ListSandboxesResponse as ProtoListSandboxesResponse, SandboxInfo as ProtoSandboxInfo, StartSandboxRequest as ProtoStartSandboxRequest } from "./generated/coreweave/sandbox/v1beta2/gateway.js";
export declare const DEFAULT_CONTAINER_IMAGE = "python:3.11";
export declare function commandName(command: Command): string;
export declare function commandArgs(command: Command): string[];
export declare function timeoutMsToSeconds(timeoutMs: number | undefined): number;
export declare function toProtoStartRequest(request: StartSandboxRequest): ProtoStartSandboxRequest;
export declare function toProtoExecRequest(request: ExecRequest): ProtoExecSandboxRequest;
export declare function toProtoListSandboxesRequest(request: ListSandboxesOptions): ProtoListSandboxesRequest;
export declare function toSdkProcessResult(command: Command, response: ProtoExecResponse): ProcessResult;
export declare function toSdkListSandboxesResult(response: ProtoListSandboxesResponse): ListSandboxesResult;
export declare function toSdkSandboxInfo(info: ProtoSandboxInfo): SandboxInfo;
export declare function toSdkSandboxStatus(status: ProtoSandboxStatus): SandboxStatus;
//# sourceMappingURL=mappers.d.ts.map