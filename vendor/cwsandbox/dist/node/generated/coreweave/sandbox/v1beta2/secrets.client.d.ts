import type { RpcTransport } from "@protobuf-ts/runtime-rpc";
import type { ServiceInfo } from "@protobuf-ts/runtime-rpc";
import type { DeleteSecretStoreResponse } from "./secrets.js";
import type { DeleteSecretStoreRequest } from "./secrets.js";
import type { ListSecretStoresResponse } from "./secrets.js";
import type { ListSecretStoresRequest } from "./secrets.js";
import type { GetSecretStoreResponse } from "./secrets.js";
import type { GetSecretStoreRequest } from "./secrets.js";
import type { CreateSecretStoreResponse } from "./secrets.js";
import type { CreateSecretStoreRequest } from "./secrets.js";
import type { UnaryCall } from "@protobuf-ts/runtime-rpc";
import type { RpcOptions } from "@protobuf-ts/runtime-rpc";
/**
 * @generated from protobuf service coreweave.sandbox.v1beta2.SecretStoreService
 */
export interface ISecretStoreServiceClient {
    /**
     * CreateSecretStore registers a new secret store for the caller's organization.
     *
     * @generated from protobuf rpc: CreateSecretStore
     */
    createSecretStore(input: CreateSecretStoreRequest, options?: RpcOptions): UnaryCall<CreateSecretStoreRequest, CreateSecretStoreResponse>;
    /**
     * GetSecretStore retrieves a secret store by name.
     *
     * @generated from protobuf rpc: GetSecretStore
     */
    getSecretStore(input: GetSecretStoreRequest, options?: RpcOptions): UnaryCall<GetSecretStoreRequest, GetSecretStoreResponse>;
    /**
     * ListSecretStores lists secret stores for the caller's organization.
     *
     * @generated from protobuf rpc: ListSecretStores
     */
    listSecretStores(input: ListSecretStoresRequest, options?: RpcOptions): UnaryCall<ListSecretStoresRequest, ListSecretStoresResponse>;
    /**
     * DeleteSecretStore removes a secret store by name.
     *
     * @generated from protobuf rpc: DeleteSecretStore
     */
    deleteSecretStore(input: DeleteSecretStoreRequest, options?: RpcOptions): UnaryCall<DeleteSecretStoreRequest, DeleteSecretStoreResponse>;
}
/**
 * @generated from protobuf service coreweave.sandbox.v1beta2.SecretStoreService
 */
export declare class SecretStoreServiceClient implements ISecretStoreServiceClient, ServiceInfo {
    private readonly _transport;
    typeName: string;
    methods: import("@protobuf-ts/runtime-rpc").MethodInfo<any, any>[];
    options: {
        [extensionName: string]: import("@protobuf-ts/runtime").JsonValue;
    };
    constructor(_transport: RpcTransport);
    /**
     * CreateSecretStore registers a new secret store for the caller's organization.
     *
     * @generated from protobuf rpc: CreateSecretStore
     */
    createSecretStore(input: CreateSecretStoreRequest, options?: RpcOptions): UnaryCall<CreateSecretStoreRequest, CreateSecretStoreResponse>;
    /**
     * GetSecretStore retrieves a secret store by name.
     *
     * @generated from protobuf rpc: GetSecretStore
     */
    getSecretStore(input: GetSecretStoreRequest, options?: RpcOptions): UnaryCall<GetSecretStoreRequest, GetSecretStoreResponse>;
    /**
     * ListSecretStores lists secret stores for the caller's organization.
     *
     * @generated from protobuf rpc: ListSecretStores
     */
    listSecretStores(input: ListSecretStoresRequest, options?: RpcOptions): UnaryCall<ListSecretStoresRequest, ListSecretStoresResponse>;
    /**
     * DeleteSecretStore removes a secret store by name.
     *
     * @generated from protobuf rpc: DeleteSecretStore
     */
    deleteSecretStore(input: DeleteSecretStoreRequest, options?: RpcOptions): UnaryCall<DeleteSecretStoreRequest, DeleteSecretStoreResponse>;
}
//# sourceMappingURL=secrets.client.d.ts.map