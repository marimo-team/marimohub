import type { StreamLogsRequest } from "../types.js";
import type { LogStreamRequest as ProtoLogStreamRequest, LogStreamResponse as ProtoLogStreamResponse } from "./generated/coreweave/sandbox/v1beta2/streaming.js";
export interface LogStreamingRequestWriter {
    complete(): Promise<void>;
    send(message: ProtoLogStreamRequest): Promise<void>;
}
export declare function toLogStreamInitRequest(request: StreamLogsRequest): ProtoLogStreamRequest;
export declare function toLogStreamCloseRequest(): ProtoLogStreamRequest;
export declare function sendLogStreamInit(writer: LogStreamingRequestWriter, request: StreamLogsRequest): Promise<void>;
export declare function sendLogStreamClose(writer: LogStreamingRequestWriter): Promise<void>;
export declare function logStreamError(response: ProtoLogStreamResponse): {
    readonly code: string;
    readonly message: string;
} | undefined;
//# sourceMappingURL=log-streaming-requests.d.ts.map