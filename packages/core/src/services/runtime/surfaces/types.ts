import type { AuthUser } from '../../../ports/auth';
import type { SandboxInstance } from '../../../ports/sandbox';

export const SECONDARY_SURFACE_IDS = ['vscode', 'opencode'] as const;
export type SecondarySurfaceId = (typeof SECONDARY_SURFACE_IDS)[number];
export type SurfaceId = 'marimo' | SecondarySurfaceId;

export interface SurfaceContext {
	sessionId: string;
	projectId: string;
	notebookId: string;
	workspaceDir: string;
	processWorkspaceDir: string;
	notebookFile: string;
	user: AuthUser;
	editIntent: 'persistent' | 'temporary';
	exposure: 'proxy' | 'subdomain';
	basePath?: string;
	userDataDir: string;
}

export interface SurfaceProbe {
	[key: string]: unknown;
	available: boolean;
	reason?: string;
	version?: string;
}

export interface SurfaceSpec {
	id: SurfaceId;
	primary: boolean;
	defaultPort: number;
	supportedExposures: readonly SurfaceContext['exposure'][];
	supportsOpenPath?: boolean;
	proxyPath: 'strip-prefix' | 'preserve-prefix';
	probe(instance: SandboxInstance): Promise<SurfaceProbe>;
	prepare?(instance: SandboxInstance, ctx: SurfaceContext): Promise<void>;
	command(ctx: SurfaceContext, port: number): { cmd: string[]; env?: Record<string, string> };
	readiness: { path: string; timeoutMs: number };
	openUrl(base: URL, ctx: SurfaceContext, opts: { open?: string }): URL;
	resolveOpenUrl?(
		instance: SandboxInstance,
		base: URL,
		ctx: SurfaceContext,
		opts: { open?: string; port: number },
	): Promise<URL>;
}
