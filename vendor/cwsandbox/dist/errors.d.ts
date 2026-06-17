export type CWSandboxErrorCode = "authentication_error" | "configuration_error" | "not_found" | "not_implemented" | "resource_exhausted" | "timeout_error" | "transport_error" | "unavailable" | "validation_error";
export type CWSandboxTransportKind = "fetch" | "grpc" | "http";
export interface CWSandboxTransportErrorOptions extends ErrorOptions {
    readonly metadata?: Readonly<Record<string, string | string[]>>;
    readonly operation?: string;
    readonly sandboxId?: string;
    readonly transport?: CWSandboxTransportKind;
    readonly transportCode?: number | string;
}
export declare class CWSandboxError extends Error {
    readonly code: CWSandboxErrorCode;
    constructor(message: string, code: CWSandboxErrorCode, options?: ErrorOptions);
}
export declare function isCWSandboxError(error: unknown): error is CWSandboxError;
export declare class CWSandboxConfigurationError extends CWSandboxError {
    constructor(message: string, options?: ErrorOptions);
}
export declare class CWSandboxNotImplementedError extends CWSandboxError {
    constructor(message: string, options?: ErrorOptions);
}
export declare class CWSandboxTransportError extends CWSandboxError {
    readonly metadata: Readonly<Record<string, string | string[]>> | undefined;
    readonly operation: string | undefined;
    readonly sandboxId: string | undefined;
    readonly transport: CWSandboxTransportKind | undefined;
    readonly transportCode: number | string | undefined;
    constructor(message: string, options?: CWSandboxTransportErrorOptions, code?: CWSandboxErrorCode);
}
export declare class CWSandboxAuthenticationError extends CWSandboxTransportError {
    constructor(message: string, options?: CWSandboxTransportErrorOptions);
}
export declare class CWSandboxNotFoundError extends CWSandboxTransportError {
    constructor(message: string, options?: CWSandboxTransportErrorOptions);
}
export declare class CWSandboxTimeoutError extends CWSandboxTransportError {
    constructor(message: string, options?: CWSandboxTransportErrorOptions);
}
export declare class CWSandboxUnavailableError extends CWSandboxTransportError {
    constructor(message: string, options?: CWSandboxTransportErrorOptions);
}
export declare class CWSandboxResourceExhaustedError extends CWSandboxTransportError {
    constructor(message: string, options?: CWSandboxTransportErrorOptions);
}
export declare class CWSandboxValidationError extends CWSandboxError {
    constructor(message: string, options?: ErrorOptions);
}
//# sourceMappingURL=errors.d.ts.map