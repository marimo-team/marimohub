import type { DeleteSandboxRequest, ExecRequest, GetSandboxRequest, GetSandboxResult, ListSandboxesOptions, ListSandboxesResult, LogEntryStream, LogRawStream, LogStream, ProcessResult, ReadFileRequest, ReadFileResult, CommandProcess, StartSandboxRequest, StartSandboxResult, StartCommandRequest, StreamLogsRequest, StopSandboxRequest, WriteFileRequest } from "./types.js";
export interface SandboxTransport {
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
//# sourceMappingURL=transport.d.ts.map