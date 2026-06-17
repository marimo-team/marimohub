import type { StartCommandRequest } from "../types.js";
import type { ExecStreamRequest } from "./generated/coreweave/sandbox/v1beta2/streaming.js";
export interface StreamingRequestWriter {
    complete(): Promise<void>;
    send(message: ExecStreamRequest): Promise<void>;
}
export declare function toStreamingInitRequest(request: StartCommandRequest): ExecStreamRequest;
export declare function toStreamingStdinRequest(data: Uint8Array): ExecStreamRequest;
export declare function toStreamingCloseRequest(): ExecStreamRequest;
export declare function sendStreamingInit(writer: StreamingRequestWriter, request: StartCommandRequest): Promise<void>;
export declare function sendStreamingStdin(writer: StreamingRequestWriter, data: Uint8Array): Promise<void>;
export declare function sendStreamingClose(writer: StreamingRequestWriter): Promise<void>;
//# sourceMappingURL=streaming-requests.d.ts.map