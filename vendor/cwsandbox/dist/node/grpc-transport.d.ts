import type { SandboxTransport } from "../transport.js";
import type { CommandProcess, DeleteSandboxRequest, ExecRequest, GetSandboxRequest, GetSandboxResult, ListSandboxesOptions, ListSandboxesResult, LogEntryStream, LogRawStream, LogStream, ProcessResult, ReadFileRequest, ReadFileResult, StartCommandRequest, StartSandboxRequest, StartSandboxResult, StopSandboxRequest, StreamLogsRequest, WriteFileRequest } from "../types.js";
import { type GrpcMetadata } from "./grpc-channel.js";
export interface GrpcSandboxTransportOptions {
    readonly apiKey?: string;
    readonly baseUrl: string;
    readonly metadata?: GrpcMetadata;
}
export declare class GrpcSandboxTransport implements SandboxTransport {
    private readonly client;
    private readonly streamingClient;
    constructor(options: GrpcSandboxTransportOptions);
    start(request: StartSandboxRequest): Promise<StartSandboxResult>;
    get(request: GetSandboxRequest): Promise<GetSandboxResult>;
    list(options: ListSandboxesOptions): Promise<ListSandboxesResult>;
    delete(request: DeleteSandboxRequest): Promise<void>;
    exec(request: ExecRequest): Promise<ProcessResult>;
    startCommand(request: StartCommandRequest): Promise<CommandProcess>;
    streamLogs(request: StreamLogsRequest): Promise<LogEntryStream | LogRawStream | LogStream>;
    stop(request: StopSandboxRequest): Promise<void>;
    writeFile(request: WriteFileRequest): Promise<void>;
    readFile(request: ReadFileRequest): Promise<ReadFileResult>;
}
//# sourceMappingURL=grpc-transport.d.ts.map