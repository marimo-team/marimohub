import { Sandbox } from "./sandbox.js";
import type { SandboxTransport } from "./transport.js";
import type { CommandInput, FromIdOptions, ListSandboxesOptions, ListSandboxesResult, RequestOptions, SandboxId, SandboxRunOptions } from "./types.js";
export interface SandboxClientOptions {
    readonly transport: SandboxTransport;
}
export type WithSandboxCallback<TResult> = (sandbox: Sandbox) => Promise<TResult> | TResult;
export declare class SandboxClient {
    private readonly transport;
    constructor(options: SandboxClientOptions);
    /**
     * Create a long-lived sandbox and wait until it is ready for SDK operations.
     *
     * Uses the SDK default keep-alive command for the sandbox main process. Pass
     * `waitUntilRunning: false` to resolve after the backend accepts the start
     * request instead of waiting for lifecycle readiness.
     */
    create(options?: SandboxRunOptions): Promise<Sandbox>;
    /**
     * Start a sandbox with a custom main process and wait until it is running.
     *
     * The command runs as the sandbox's main process and drives sandbox logs.
     * Pass `waitUntilRunning: false` to resolve after the backend accepts the
     * start request.
     */
    run(command: CommandInput, options?: SandboxRunOptions): Promise<Sandbox>;
    fromId(sandboxId: SandboxId, options?: FromIdOptions): Promise<Sandbox>;
    list(options?: ListSandboxesOptions): Promise<ListSandboxesResult>;
    delete(sandboxId: SandboxId, options?: RequestOptions): Promise<void>;
    /**
     * Run short-lived work in a long-lived sandbox and stop it after the callback.
     *
     * The callback receives a `running` sandbox by default. Pass a command as the
     * first argument only when you need a custom sandbox main process.
     */
    withSandbox<TResult>(callback: WithSandboxCallback<TResult>, options?: SandboxRunOptions): Promise<TResult>;
    withSandbox<TResult>(command: CommandInput, callback: WithSandboxCallback<TResult>, options?: SandboxRunOptions): Promise<TResult>;
}
//# sourceMappingURL=client.d.ts.map