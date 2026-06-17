import { CWSandboxTransportError } from "../errors.js";
export interface GrpcErrorContext {
    readonly operation: string;
    readonly sandboxId?: string;
}
export declare function mapGrpcError(error: unknown, context: GrpcErrorContext): CWSandboxTransportError;
//# sourceMappingURL=errors.d.ts.map