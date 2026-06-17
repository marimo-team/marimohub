export type PortInput = number | PortOptions;
export type PortProtocol = "SCTP" | "TCP" | "UDP" | (string & {});
export interface PortOptions {
    readonly name?: string;
    readonly port: number;
    readonly protocol?: PortProtocol;
}
export interface NetworkOptions {
    readonly egressMode?: string;
    readonly exposedPorts?: readonly number[];
    readonly ingressMode?: string;
}
//# sourceMappingURL=network.d.ts.map