import { GatewayServiceClient } from "./generated/coreweave/sandbox/v1beta2/gateway.client.js";
import { GatewayStreamingServiceClient } from "./generated/coreweave/sandbox/v1beta2/streaming.client.js";
export type GrpcMetadata = Readonly<Record<string, string>>;
export interface GrpcClientOptions {
    readonly apiKey?: string;
    readonly baseUrl: string;
    readonly metadata?: GrpcMetadata;
}
export interface GrpcClients {
    readonly client: GatewayServiceClient;
    readonly streamingClient: GatewayStreamingServiceClient;
}
export declare function createGrpcClients(options: GrpcClientOptions): GrpcClients;
//# sourceMappingURL=grpc-channel.d.ts.map