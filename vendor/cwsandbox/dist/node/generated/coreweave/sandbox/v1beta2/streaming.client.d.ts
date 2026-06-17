import type { RpcTransport } from "@protobuf-ts/runtime-rpc";
import type { ServiceInfo } from "@protobuf-ts/runtime-rpc";
import type { LogStreamResponse } from "./streaming.js";
import type { LogStreamRequest } from "./streaming.js";
import type { ExecStreamResponse } from "./streaming.js";
import type { ExecStreamRequest } from "./streaming.js";
import type { DuplexStreamingCall } from "@protobuf-ts/runtime-rpc";
import type { RpcOptions } from "@protobuf-ts/runtime-rpc";
/**
 * GatewayStreamingService provides real-time streaming capabilities for sandboxes.
 * This service uses bidirectional streaming for full-duplex communication.
 *
 * @generated from protobuf service coreweave.sandbox.v1beta2.GatewayStreamingService
 */
export interface IGatewayStreamingServiceClient {
    /**
     * StreamExec executes a command with real-time stdin/stdout/stderr streaming.
     * The client sends ExecStreamRequest messages (init, stdin, resize, close).
     * The server sends ExecStreamResponse messages (output, exit, error).
     *
     * @generated from protobuf rpc: StreamExec
     */
    streamExec(options?: RpcOptions): DuplexStreamingCall<ExecStreamRequest, ExecStreamResponse>;
    /**
     * StreamLogs tails logs from a sandbox in real-time.
     * The client sends LogStreamRequest messages (init, close).
     * The server sends LogStreamResponse messages (data, error, complete).
     *
     * @generated from protobuf rpc: StreamLogs
     */
    streamLogs(options?: RpcOptions): DuplexStreamingCall<LogStreamRequest, LogStreamResponse>;
}
/**
 * GatewayStreamingService provides real-time streaming capabilities for sandboxes.
 * This service uses bidirectional streaming for full-duplex communication.
 *
 * @generated from protobuf service coreweave.sandbox.v1beta2.GatewayStreamingService
 */
export declare class GatewayStreamingServiceClient implements IGatewayStreamingServiceClient, ServiceInfo {
    private readonly _transport;
    typeName: string;
    methods: import("@protobuf-ts/runtime-rpc").MethodInfo<any, any>[];
    options: {
        [extensionName: string]: import("@protobuf-ts/runtime").JsonValue;
    };
    constructor(_transport: RpcTransport);
    /**
     * StreamExec executes a command with real-time stdin/stdout/stderr streaming.
     * The client sends ExecStreamRequest messages (init, stdin, resize, close).
     * The server sends ExecStreamResponse messages (output, exit, error).
     *
     * @generated from protobuf rpc: StreamExec
     */
    streamExec(options?: RpcOptions): DuplexStreamingCall<ExecStreamRequest, ExecStreamResponse>;
    /**
     * StreamLogs tails logs from a sandbox in real-time.
     * The client sends LogStreamRequest messages (init, close).
     * The server sends LogStreamResponse messages (data, error, complete).
     *
     * @generated from protobuf rpc: StreamLogs
     */
    streamLogs(options?: RpcOptions): DuplexStreamingCall<LogStreamRequest, LogStreamResponse>;
}
//# sourceMappingURL=streaming.client.d.ts.map