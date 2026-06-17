import type { RequestOptions } from "./common.js";
export type LogStreamMode = "entries" | "lines" | "raw";
export interface LogResumeCursor {
    readonly offset: bigint | number | string;
    readonly sessionId: string;
}
export interface LogStreamOptions extends RequestOptions {
    readonly follow?: boolean;
    readonly resume?: LogResumeCursor;
    readonly sinceTime?: Date | string;
    readonly tailLines?: number;
    readonly timestamps?: boolean;
}
export interface LogReadOptions extends Omit<LogStreamOptions, "follow"> {
    readonly follow?: false;
}
export interface SandboxLogs {
    read(options?: LogReadOptions): Promise<string[]>;
    stream(options?: LogStreamOptions): Promise<LogStream>;
    streamEntries(options?: LogStreamOptions): Promise<LogEntryStream>;
    streamRaw(options?: LogStreamOptions): Promise<LogRawStream>;
}
export interface LogStream extends AsyncIterable<string> {
    readonly closed: boolean;
    readonly offset: string | undefined;
    readonly sessionId: string | undefined;
    cancel(options?: RequestOptions): Promise<void>;
    close(options?: RequestOptions): Promise<void>;
}
export interface LogEntry {
    readonly line: string;
    readonly offset?: string;
    readonly sessionId?: string;
    readonly timestamp?: Date;
}
export interface LogEntryStream extends AsyncIterable<LogEntry> {
    readonly closed: boolean;
    readonly offset: string | undefined;
    readonly sessionId: string | undefined;
    cancel(options?: RequestOptions): Promise<void>;
    close(options?: RequestOptions): Promise<void>;
}
export interface LogRawChunk {
    readonly data: Uint8Array;
    readonly offset?: string;
    readonly sessionId?: string;
    readonly text: string;
    readonly timestamp?: Date;
}
export interface LogRawStream extends AsyncIterable<LogRawChunk> {
    readonly closed: boolean;
    readonly offset: string | undefined;
    readonly sessionId: string | undefined;
    cancel(options?: RequestOptions): Promise<void>;
    close(options?: RequestOptions): Promise<void>;
}
//# sourceMappingURL=logs.d.ts.map