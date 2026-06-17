import type { LogEntryStream, LogRawStream, LogStream, LogStreamMode } from "../types.js";
export interface LogStreamControls {
    cancel(reason: unknown): Promise<void>;
    close(): Promise<void>;
}
interface TimestampLike {
    readonly nanos: number;
    readonly seconds: string;
}
export type LogStreamDataEvent = {
    readonly data: Uint8Array;
    readonly offset?: string;
    readonly sessionId?: string;
    readonly timestamp?: TimestampLike;
};
export type InternalLogEvent = ({
    readonly type: "data";
} & LogStreamDataEvent) | {
    readonly error: unknown;
    readonly type: "error";
} | {
    readonly type: "complete";
};
export interface LogStreamController<TStream extends LogStream | LogEntryStream | LogRawStream> {
    readonly stream: TStream;
    dispatch(event: InternalLogEvent): Promise<void>;
}
export declare function createLogStream(mode: "lines", controls: LogStreamControls): LogStreamController<LogStream>;
export declare function createLogStream(mode: "entries", controls: LogStreamControls): LogStreamController<LogEntryStream>;
export declare function createLogStream(mode: "raw", controls: LogStreamControls): LogStreamController<LogRawStream>;
export declare function createLogStream(mode: LogStreamMode, controls: LogStreamControls): LogStreamController<LogStream | LogEntryStream | LogRawStream>;
export declare function timestampToDate(timestamp: TimestampLike): Date;

//# sourceMappingURL=log-stream.d.ts.map