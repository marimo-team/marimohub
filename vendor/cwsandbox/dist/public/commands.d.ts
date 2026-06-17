import type { RequestOptions } from "./common.js";
export type Command = readonly [string, ...string[]];
export type CommandInputData = string | Uint8Array;
export type CommandInput = Command | ReadonlyArray<string>;
export type CommandOutputStream = AsyncIterable<string>;
export type CommandProcessStatus = "cancelled" | "exited" | "failed" | "running" | "starting";
export interface ExecOptions extends RequestOptions {
    readonly bufferedMaxKiB?: number;
    readonly cwd?: string;
}
export interface StartCommandOptions extends RequestOptions {
    readonly bufferedMaxKiB?: number;
    readonly cwd?: string;
    readonly stdin?: boolean;
}
export interface StartCommandOptionsWithStdin extends StartCommandOptions {
    readonly stdin: true;
}
export interface ProcessResult {
    readonly command: Command;
    readonly exitCode: number;
    readonly failed: boolean;
    readonly ok: boolean;
    readonly stderr: string;
    readonly stderrBytes: Uint8Array;
    readonly stderrBytesProduced: number;
    readonly stderrTruncated: boolean;
    readonly stdout: string;
    readonly stdoutBytes: Uint8Array;
    readonly stdoutBytesProduced: number;
    readonly stdoutTruncated: boolean;
}
export interface SandboxCommands {
    run(command: CommandInput, options?: ExecOptions): Promise<ProcessResult>;
    start(command: CommandInput, options: StartCommandOptionsWithStdin): Promise<CommandProcessWithStdin>;
    start(command: CommandInput, options?: StartCommandOptions): Promise<CommandProcess>;
}
export interface CommandProcess {
    readonly command: Command;
    readonly exitCode: number | undefined;
    readonly stderr: CommandOutputStream;
    readonly status: CommandProcessStatus;
    readonly stdout: CommandOutputStream;
    cancel(options?: RequestOptions): Promise<void>;
    poll(): number | undefined;
    wait(options?: RequestOptions): Promise<ProcessResult>;
}
export interface CommandProcessWithStdin extends CommandProcess {
    readonly stdin: CommandInputWriter;
}
export interface CommandInputWriter {
    readonly closed: boolean;
    close(options?: RequestOptions): Promise<void>;
    write(data: CommandInputData, options?: RequestOptions): Promise<void>;
    writeln(text: string, options?: RequestOptions): Promise<void>;
}
//# sourceMappingURL=commands.d.ts.map