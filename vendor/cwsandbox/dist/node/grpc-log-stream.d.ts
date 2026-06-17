import type { LogEntryStream, LogRawStream, LogStream, StreamLogsRequest } from "../types.js";
import type { GatewayStreamingServiceClient } from "./generated/coreweave/sandbox/v1beta2/streaming.client.js";
export declare function startGrpcLogStream(streamingClient: GatewayStreamingServiceClient, request: StreamLogsRequest): Promise<LogEntryStream | LogRawStream | LogStream>;
//# sourceMappingURL=grpc-log-stream.d.ts.map