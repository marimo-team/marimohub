import type { SandboxTransport } from "./transport.js";
import type { CommandInput, ExecOptions, ProcessResult, RequestOptions, SandboxCommands, SandboxFiles, SandboxId, SandboxLogs, SandboxStatus, StopOptions, WaitOptions } from "./types.js";
interface SandboxOptions {
    readonly sandboxId: SandboxId;
    readonly transport: SandboxTransport;
}
export declare class Sandbox {
    readonly commands: SandboxCommands;
    readonly files: SandboxFiles;
    readonly logs: SandboxLogs;
    readonly sandboxId: SandboxId;
    private readonly runtime;
    constructor(options: SandboxOptions);
    exec(command: CommandInput, options?: ExecOptions): Promise<ProcessResult>;
    getStatus(options?: RequestOptions): Promise<SandboxStatus>;
    wait(options?: WaitOptions): Promise<Sandbox>;
    stop(options?: StopOptions): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
    delete(options?: RequestOptions): Promise<void>;
}

//# sourceMappingURL=sandbox.d.ts.map