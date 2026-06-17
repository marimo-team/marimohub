import type { Command, ExecOptions, StartCommandOptions } from "../public/commands.js";
import type { RequestOptions } from "../public/common.js";
import type { LogStreamMode, LogStreamOptions } from "../public/logs.js";
import type { GetSandboxResult, SandboxId, SandboxRunOptions, StartSandboxResult, StopOptions } from "../public/sandbox.js";
export interface StartSandboxRequest extends Omit<SandboxRunOptions, "waitUntilRunning"> {
    readonly command: Command;
}
export type { StartSandboxResult, GetSandboxResult };
export interface GetSandboxRequest extends RequestOptions {
    readonly sandboxId: SandboxId;
}
export interface ExecRequest extends ExecOptions {
    readonly command: Command;
    readonly sandboxId: SandboxId;
}
export interface StartCommandRequest extends StartCommandOptions {
    readonly command: Command;
    readonly sandboxId: SandboxId;
}
export interface StreamLogsRequest extends LogStreamOptions {
    readonly mode: LogStreamMode;
    readonly sandboxId: SandboxId;
}
export interface StopSandboxRequest extends StopOptions {
    readonly sandboxId: SandboxId;
}
export interface DeleteSandboxRequest extends RequestOptions {
    readonly sandboxId: SandboxId;
}
export interface WriteFileRequest extends RequestOptions {
    readonly content: Uint8Array;
    readonly path: string;
    readonly sandboxId: SandboxId;
}
export interface ReadFileRequest extends RequestOptions {
    readonly path: string;
    readonly sandboxId: SandboxId;
}
export interface ReadFileResult {
    readonly content: Uint8Array;
}
//# sourceMappingURL=types.d.ts.map