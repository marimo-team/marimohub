import type { SandboxTransport } from "../transport.js";
import type { SandboxId } from "../types.js";
export interface SandboxRuntime {
    readonly sandboxId: SandboxId;
    readonly transport: SandboxTransport;
}
//# sourceMappingURL=runtime.d.ts.map