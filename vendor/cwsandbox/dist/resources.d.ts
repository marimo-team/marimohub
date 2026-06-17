import type { ResourceOptions, ResourceSpec } from "./types.js";
export declare function validateResources(resources: ResourceOptions | undefined): void;
export declare function isAdvancedResources(resources: ResourceOptions): resources is {
    readonly limits: ResourceSpec;
    readonly requests: ResourceSpec;
};
export declare function validateResourceSpec(spec: ResourceSpec, fieldName: string): void;
//# sourceMappingURL=resources.d.ts.map