import { SandboxClient } from "../client.js";
export { DEFAULT_KEEP_ALIVE_COMMAND } from "../defaults.js";
export { GrpcSandboxTransport } from "./grpc-transport.js";
export type { GrpcSandboxTransportOptions } from "./grpc-transport.js";
export { DEFAULT_CONTAINER_IMAGE } from "./mappers.js";
export declare const DEFAULT_BASE_URL = "https://api.cwsandbox.com";
type EnvironmentValue = string | undefined;
export interface CWSandboxEnvironment extends Readonly<Record<string, EnvironmentValue>> {
    readonly CWSANDBOX_API_KEY?: string;
    readonly CWSANDBOX_BASE_URL?: string;
}
export interface NodeSandboxClientOptions {
    readonly apiKey: string;
    readonly baseUrl?: string;
}
export declare function createSandboxClient(options: NodeSandboxClientOptions): SandboxClient;
export declare function createSandboxClientFromEnv(env?: CWSandboxEnvironment): SandboxClient;
//# sourceMappingURL=index.d.ts.map