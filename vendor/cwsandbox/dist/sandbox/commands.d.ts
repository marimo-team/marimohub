import type { CommandInput, ExecOptions, ProcessResult, SandboxCommands } from "../types.js";
import type { SandboxRuntime } from "./runtime.js";
export declare function createSandboxCommands(runtime: SandboxRuntime): SandboxCommands;
export declare function execCommand(runtime: SandboxRuntime, command: CommandInput, options?: ExecOptions): Promise<ProcessResult>;
//# sourceMappingURL=commands.d.ts.map