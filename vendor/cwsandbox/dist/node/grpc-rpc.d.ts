import type { RpcOptions } from "@protobuf-ts/runtime-rpc";
export declare function withGrpcErrorMapping<TResult>(operation: string, run: () => Promise<TResult>, sandboxId?: string): Promise<TResult>;
export declare function toRpcOptions(request: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
}): RpcOptions;
export declare function linkedAbortController(signal: AbortSignal | undefined): AbortController;
//# sourceMappingURL=grpc-rpc.d.ts.map