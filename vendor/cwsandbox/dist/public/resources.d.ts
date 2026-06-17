export type ResourceOptions = ResourceSpec | ResourceRequestsAndLimits;
export interface ResourceSpec {
    readonly cpu?: string;
    readonly memory?: string;
}
export interface ResourceRequestsAndLimits {
    readonly limits: ResourceSpec;
    readonly requests: ResourceSpec;
}
//# sourceMappingURL=resources.d.ts.map