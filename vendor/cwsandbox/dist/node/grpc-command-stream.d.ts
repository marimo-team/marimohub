import type { CommandProcess, StartCommandRequest } from "../types.js";
import type { GatewayStreamingServiceClient } from "./generated/coreweave/sandbox/v1beta2/streaming.client.js";
export declare function startGrpcCommand(streamingClient: GatewayStreamingServiceClient, request: StartCommandRequest): Promise<CommandProcess>;
//# sourceMappingURL=grpc-command-stream.d.ts.map