import { z } from 'zod';

export const NAMESPACE = 'marimohub.notebook-bridge';
export const VERSION = { major: 1, minor: 0 } as const;
export const QUERY_CAPABILITY = 'query-params.v1';
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 5_000;
export const UPDATE_INTERVAL_MS = 100;
export const MAX_QUERY_BYTES = 64 * 1024;
const identifier = z.string().min(1).max(128);
const version = z.object({
	major: z.number().int().nonnegative(),
	minor: z.number().int().nonnegative(),
});
const capabilities = z.array(z.string().max(128)).max(32);
const base = { namespace: z.literal(NAMESPACE), version, capabilities };
export const Ready = z.object({ ...base, kind: z.literal('ready'), documentId: identifier });
export const Connect = z.object({
	...base,
	kind: z.literal('connect'),
	documentId: identifier,
	connectionId: identifier,
	excludedKeys: z.array(z.string().max(MAX_QUERY_BYTES)).max(256),
});
export const Probe = z.object({ namespace: z.literal(NAMESPACE), kind: z.literal('probe') });
export const QuerySnapshot = z
	.object({
		revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		entries: z
			.array(z.tuple([z.string().max(MAX_QUERY_BYTES), z.string().max(MAX_QUERY_BYTES)]))
			.max(256),
	})
	.refine(({ entries }) => new URLSearchParams(entries).toString().length <= MAX_QUERY_BYTES);
export type QuerySnapshot = z.infer<typeof QuerySnapshot>;
export const QueryResult = z.object({ applied: z.boolean() });
export type QueryResult = z.infer<typeof QueryResult>;
export interface HostApi {
	replaceQuery(snapshot: QuerySnapshot): QueryResult;
}
export interface NotebookApi {
	connected(): { ready: true };
}
export const ConnectedResult = z.object({ ready: z.literal(true) });

export type BridgeStatus = 'connecting' | 'connected' | 'unavailable' | 'disposed';
export interface BridgeHandle {
	readonly status: BridgeStatus;
	dispose(): void;
}
export interface StatusOptions {
	onStatus?: (status: BridgeStatus) => void;
}

export function compatible(peer: { version: { major: number }; capabilities: string[] }): boolean {
	return peer.version.major === VERSION.major && peer.capabilities.includes(QUERY_CAPABILITY);
}

export function exactOrigin(value: string): string {
	const url = new URL(value);
	if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value)
		throw new Error('Expected an HTTP(S) origin');
	return url.origin;
}

export function randomIdentifier(crypto: Pick<Crypto, 'getRandomValues'>): string {
	// getRandomValues also works on HTTP deployments where randomUUID is unavailable.
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}
