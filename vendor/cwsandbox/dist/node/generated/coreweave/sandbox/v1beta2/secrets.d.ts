import { ServiceType } from "@protobuf-ts/runtime-rpc";
import type { BinaryWriteOptions } from "@protobuf-ts/runtime";
import type { IBinaryWriter } from "@protobuf-ts/runtime";
import type { BinaryReadOptions } from "@protobuf-ts/runtime";
import type { IBinaryReader } from "@protobuf-ts/runtime";
import type { PartialMessage } from "@protobuf-ts/runtime";
import { MessageType } from "@protobuf-ts/runtime";
import { Timestamp } from "../../../google/protobuf/timestamp.js";
/**
 * SecretStoreReference groups secret mappings by store name.
 * Clients include these in StartSandboxRequest to request secret injection.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.SecretStoreReference
 */
export interface SecretStoreReference {
    /**
     * Name of a configured secret store (resolved server-side).
     *
     * @generated from protobuf field: string store_name = 1
     */
    storeName: string;
    /**
     * Secrets to fetch from this store and inject into the sandbox.
     *
     * @generated from protobuf field: repeated coreweave.sandbox.v1beta2.SecretMapping secrets = 2
     */
    secrets: SecretMapping[];
}
/**
 * SecretMapping maps a provider-specific secret path to an environment variable.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.SecretMapping
 */
export interface SecretMapping {
    /**
     * Provider-specific secret identifier (e.g., "HF_TOKEN", "secret/data/myapp/db").
     *
     * @generated from protobuf field: string path = 1
     */
    path: string;
    /**
     * Optional field within a structured secret (for key-value secrets).
     *
     * @generated from protobuf field: string field = 2
     */
    field: string;
    /**
     * Environment variable name for delivery into the sandbox container.
     *
     * @generated from protobuf field: string env_var = 3
     */
    envVar: string;
}
/**
 * ResolvedSecret is a fully-resolved secret ready for delivery to Runner.
 * Included in PlacementRequest after Gateway resolves all secrets from providers.
 * Secret values MUST NOT be logged, cached, or persisted outside of memory.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.ResolvedSecret
 */
export interface ResolvedSecret {
    /**
     * Target environment variable name.
     *
     * @generated from protobuf field: string env_var = 1
     */
    envVar: string;
    /**
     * Raw secret value. Treated as opaque bytes.
     *
     * @generated from protobuf field: bytes value = 2
     */
    value: Uint8Array;
}
/**
 * WandBStoreConfig holds configuration for a Weights & Biases secret store.
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.WandBStoreConfig
 */
export interface WandBStoreConfig {
    /**
     * Base URL for the W&B API (e.g., "https://api.wandb.ai").
     *
     * @generated from protobuf field: string api_url = 1
     */
    apiUrl: string;
    /**
     * Optional W&B team/entity scope.
     *
     * @generated from protobuf field: string team = 2
     */
    team: string;
}
/**
 * SecretStore represents an org-level secret store configuration.
 * Stores define connections to external secrets providers (W&B, AWS, GCP, etc.).
 *
 * @generated from protobuf message coreweave.sandbox.v1beta2.SecretStore
 */
export interface SecretStore {
    /**
     * Server-generated unique identifier.
     *
     * @generated from protobuf field: string id = 1
     */
    id: string;
    /**
     * Organization that owns this store (from auth context).
     *
     * @generated from protobuf field: string organization_id = 2
     */
    organizationId: string;
    /**
     * User-provided name, unique within the organization.
     * Must match pattern: ^[a-z][a-z0-9-]{2,62}$
     *
     * @generated from protobuf field: string name = 3
     */
    name: string;
    /**
     * Provider type.
     *
     * @generated from protobuf field: coreweave.sandbox.v1beta2.SecretStoreProviderType provider_type = 4
     */
    providerType: SecretStoreProviderType;
    /**
     * Provider-specific configuration.
     *
     * @generated from protobuf oneof: provider_config
     */
    providerConfig: {
        oneofKind: "wandb";
        /**
         * @generated from protobuf field: coreweave.sandbox.v1beta2.WandBStoreConfig wandb = 10
         */
        wandb: WandBStoreConfig;
    } | {
        oneofKind: undefined;
    };
    /**
     * Server-generated timestamps.
     *
     * @generated from protobuf field: google.protobuf.Timestamp created_at = 20
     */
    createdAt?: Timestamp;
    /**
     * @generated from protobuf field: google.protobuf.Timestamp updated_at = 21
     */
    updatedAt?: Timestamp;
}
/**
 * @generated from protobuf message coreweave.sandbox.v1beta2.CreateSecretStoreRequest
 */
export interface CreateSecretStoreRequest {
    /**
     * Store name, unique within the organization.
     *
     * @generated from protobuf field: string name = 1
     */
    name: string;
    /**
     * Provider type.
     *
     * @generated from protobuf field: coreweave.sandbox.v1beta2.SecretStoreProviderType provider_type = 2
     */
    providerType: SecretStoreProviderType;
    /**
     * Provider-specific configuration.
     *
     * @generated from protobuf oneof: provider_config
     */
    providerConfig: {
        oneofKind: "wandb";
        /**
         * @generated from protobuf field: coreweave.sandbox.v1beta2.WandBStoreConfig wandb = 10
         */
        wandb: WandBStoreConfig;
    } | {
        oneofKind: undefined;
    };
}
/**
 * @generated from protobuf message coreweave.sandbox.v1beta2.CreateSecretStoreResponse
 */
export interface CreateSecretStoreResponse {
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.SecretStore secret_store = 1
     */
    secretStore?: SecretStore;
}
/**
 * @generated from protobuf message coreweave.sandbox.v1beta2.GetSecretStoreRequest
 */
export interface GetSecretStoreRequest {
    /**
     * Name of the secret store to retrieve.
     *
     * @generated from protobuf field: string name = 1
     */
    name: string;
}
/**
 * @generated from protobuf message coreweave.sandbox.v1beta2.GetSecretStoreResponse
 */
export interface GetSecretStoreResponse {
    /**
     * @generated from protobuf field: coreweave.sandbox.v1beta2.SecretStore secret_store = 1
     */
    secretStore?: SecretStore;
}
/**
 * @generated from protobuf message coreweave.sandbox.v1beta2.ListSecretStoresRequest
 */
export interface ListSecretStoresRequest {
    /**
     * Maximum number of stores to return. Default 50, max 100.
     *
     * @generated from protobuf field: int32 page_size = 1
     */
    pageSize: number;
    /**
     * Pagination token from a previous ListSecretStores response.
     *
     * @generated from protobuf field: string page_token = 2
     */
    pageToken: string;
}
/**
 * @generated from protobuf message coreweave.sandbox.v1beta2.ListSecretStoresResponse
 */
export interface ListSecretStoresResponse {
    /**
     * @generated from protobuf field: repeated coreweave.sandbox.v1beta2.SecretStore secret_stores = 1
     */
    secretStores: SecretStore[];
    /**
     * Token for retrieving the next page. Empty if no more results.
     *
     * @generated from protobuf field: string next_page_token = 2
     */
    nextPageToken: string;
}
/**
 * @generated from protobuf message coreweave.sandbox.v1beta2.DeleteSecretStoreRequest
 */
export interface DeleteSecretStoreRequest {
    /**
     * Name of the secret store to delete.
     *
     * @generated from protobuf field: string name = 1
     */
    name: string;
}
/**
 * @generated from protobuf message coreweave.sandbox.v1beta2.DeleteSecretStoreResponse
 */
export interface DeleteSecretStoreResponse {
}
/**
 * SecretStoreProviderType enumerates supported secret store provider backends.
 *
 * @generated from protobuf enum coreweave.sandbox.v1beta2.SecretStoreProviderType
 */
export declare enum SecretStoreProviderType {
    /**
     * @generated from protobuf enum value: SECRET_STORE_PROVIDER_TYPE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from protobuf enum value: SECRET_STORE_PROVIDER_TYPE_WANDB = 1;
     */
    WANDB = 1
}
declare class SecretStoreReference$Type extends MessageType<SecretStoreReference> {
    constructor();
    create(value?: PartialMessage<SecretStoreReference>): SecretStoreReference;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: SecretStoreReference): SecretStoreReference;
    internalBinaryWrite(message: SecretStoreReference, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.SecretStoreReference
 */
export declare const SecretStoreReference: SecretStoreReference$Type;
declare class SecretMapping$Type extends MessageType<SecretMapping> {
    constructor();
    create(value?: PartialMessage<SecretMapping>): SecretMapping;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: SecretMapping): SecretMapping;
    internalBinaryWrite(message: SecretMapping, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.SecretMapping
 */
export declare const SecretMapping: SecretMapping$Type;
declare class ResolvedSecret$Type extends MessageType<ResolvedSecret> {
    constructor();
    create(value?: PartialMessage<ResolvedSecret>): ResolvedSecret;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ResolvedSecret): ResolvedSecret;
    internalBinaryWrite(message: ResolvedSecret, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ResolvedSecret
 */
export declare const ResolvedSecret: ResolvedSecret$Type;
declare class WandBStoreConfig$Type extends MessageType<WandBStoreConfig> {
    constructor();
    create(value?: PartialMessage<WandBStoreConfig>): WandBStoreConfig;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: WandBStoreConfig): WandBStoreConfig;
    internalBinaryWrite(message: WandBStoreConfig, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.WandBStoreConfig
 */
export declare const WandBStoreConfig: WandBStoreConfig$Type;
declare class SecretStore$Type extends MessageType<SecretStore> {
    constructor();
    create(value?: PartialMessage<SecretStore>): SecretStore;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: SecretStore): SecretStore;
    internalBinaryWrite(message: SecretStore, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.SecretStore
 */
export declare const SecretStore: SecretStore$Type;
declare class CreateSecretStoreRequest$Type extends MessageType<CreateSecretStoreRequest> {
    constructor();
    create(value?: PartialMessage<CreateSecretStoreRequest>): CreateSecretStoreRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: CreateSecretStoreRequest): CreateSecretStoreRequest;
    internalBinaryWrite(message: CreateSecretStoreRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.CreateSecretStoreRequest
 */
export declare const CreateSecretStoreRequest: CreateSecretStoreRequest$Type;
declare class CreateSecretStoreResponse$Type extends MessageType<CreateSecretStoreResponse> {
    constructor();
    create(value?: PartialMessage<CreateSecretStoreResponse>): CreateSecretStoreResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: CreateSecretStoreResponse): CreateSecretStoreResponse;
    internalBinaryWrite(message: CreateSecretStoreResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.CreateSecretStoreResponse
 */
export declare const CreateSecretStoreResponse: CreateSecretStoreResponse$Type;
declare class GetSecretStoreRequest$Type extends MessageType<GetSecretStoreRequest> {
    constructor();
    create(value?: PartialMessage<GetSecretStoreRequest>): GetSecretStoreRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: GetSecretStoreRequest): GetSecretStoreRequest;
    internalBinaryWrite(message: GetSecretStoreRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.GetSecretStoreRequest
 */
export declare const GetSecretStoreRequest: GetSecretStoreRequest$Type;
declare class GetSecretStoreResponse$Type extends MessageType<GetSecretStoreResponse> {
    constructor();
    create(value?: PartialMessage<GetSecretStoreResponse>): GetSecretStoreResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: GetSecretStoreResponse): GetSecretStoreResponse;
    internalBinaryWrite(message: GetSecretStoreResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.GetSecretStoreResponse
 */
export declare const GetSecretStoreResponse: GetSecretStoreResponse$Type;
declare class ListSecretStoresRequest$Type extends MessageType<ListSecretStoresRequest> {
    constructor();
    create(value?: PartialMessage<ListSecretStoresRequest>): ListSecretStoresRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ListSecretStoresRequest): ListSecretStoresRequest;
    internalBinaryWrite(message: ListSecretStoresRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ListSecretStoresRequest
 */
export declare const ListSecretStoresRequest: ListSecretStoresRequest$Type;
declare class ListSecretStoresResponse$Type extends MessageType<ListSecretStoresResponse> {
    constructor();
    create(value?: PartialMessage<ListSecretStoresResponse>): ListSecretStoresResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: ListSecretStoresResponse): ListSecretStoresResponse;
    internalBinaryWrite(message: ListSecretStoresResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.ListSecretStoresResponse
 */
export declare const ListSecretStoresResponse: ListSecretStoresResponse$Type;
declare class DeleteSecretStoreRequest$Type extends MessageType<DeleteSecretStoreRequest> {
    constructor();
    create(value?: PartialMessage<DeleteSecretStoreRequest>): DeleteSecretStoreRequest;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: DeleteSecretStoreRequest): DeleteSecretStoreRequest;
    internalBinaryWrite(message: DeleteSecretStoreRequest, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.DeleteSecretStoreRequest
 */
export declare const DeleteSecretStoreRequest: DeleteSecretStoreRequest$Type;
declare class DeleteSecretStoreResponse$Type extends MessageType<DeleteSecretStoreResponse> {
    constructor();
    create(value?: PartialMessage<DeleteSecretStoreResponse>): DeleteSecretStoreResponse;
    internalBinaryRead(reader: IBinaryReader, length: number, options: BinaryReadOptions, target?: DeleteSecretStoreResponse): DeleteSecretStoreResponse;
    internalBinaryWrite(message: DeleteSecretStoreResponse, writer: IBinaryWriter, options: BinaryWriteOptions): IBinaryWriter;
}
/**
 * @generated MessageType for protobuf message coreweave.sandbox.v1beta2.DeleteSecretStoreResponse
 */
export declare const DeleteSecretStoreResponse: DeleteSecretStoreResponse$Type;
/**
 * @generated ServiceType for protobuf service coreweave.sandbox.v1beta2.SecretStoreService
 */
export declare const SecretStoreService: ServiceType;

//# sourceMappingURL=secrets.d.ts.map