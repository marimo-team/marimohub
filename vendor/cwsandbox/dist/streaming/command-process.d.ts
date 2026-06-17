import type { Command, CommandProcess, CommandProcessWithStdin } from "../types.js";
export type InternalCommandEvent = {
    readonly sessionId: string;
    readonly type: "ready";
} | {
    readonly data: Uint8Array;
    readonly type: "stdout";
} | {
    readonly data: Uint8Array;
    readonly type: "stderr";
} | {
    readonly exitCode: number;
    readonly type: "exit";
} | {
    readonly error: unknown;
    readonly type: "error";
};
export interface StreamingCommandProcessController<TProcess extends CommandProcess = CommandProcess> {
    readonly process: TProcess;
    dispatch(event: InternalCommandEvent): Promise<void>;
}
export interface CommandInputController {
    cancel(reason: unknown): Promise<void>;
    close(): Promise<void>;
    write(data: Uint8Array): Promise<void>;
}
export interface CommandProcessOptions {
    readonly bufferedMaxKiB?: number;
    readonly input?: CommandInputController;
    readonly stdin?: boolean;
}
export declare function createCommandProcess(command: Command, options: CommandProcessOptions & {
    readonly input: CommandInputController;
    readonly stdin: true;
}): StreamingCommandProcessController<CommandProcessWithStdin>;
export declare function createCommandProcess(command: Command, options?: CommandProcessOptions): StreamingCommandProcessController;
//# sourceMappingURL=command-process.d.ts.map