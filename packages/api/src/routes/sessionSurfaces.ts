import type { z } from '@hono/zod-openapi';
import type {
	AuthUser,
	OpenCodeManagedAiOptions,
	ProjectId,
	SandboxExposure,
	SecondarySurfaceId,
	Session,
	SessionId,
	SurfaceSpec,
} from '@marimo-hub/core';
import {
	joinUrlPath,
	marimoSurface,
	mintAiSessionToken,
	NotFoundError,
	opencodeSurface,
	ProxyExposure,
	SECONDARY_SURFACE_IDS,
	signProxyToken,
	SurfaceManager,
	SurfaceNotEnabledError,
	SurfaceRegistry,
	SurfaceUnsupportedProviderError,
	vscodeSurface,
} from '@marimo-hub/core';
import type { ApiDeps, SandboxConfig } from '../context';
import { errorMetadata, logEvent } from '../log';
import {
	assertSessionControl,
	assertSessionNotebookVisible,
	assertSessionSurfaceAccess,
	loadVisibleProject,
} from '../shared';
import type { CapabilitiesResponseSchema } from '../shared';

type SurfacesConfig = NonNullable<SandboxConfig['surfaces']>;
type SurfaceConfig<K extends SecondarySurfaceId> = NonNullable<SurfacesConfig[K]>;
type SurfaceCapability<K extends SecondarySurfaceId> = Extract<
	z.infer<typeof CapabilitiesResponseSchema>['surfaces'][number],
	{ id: K }
>;

interface SurfaceFactoryContext {
	deps: ApiDeps;
	user: AuthUser;
	session: Session;
	appBaseUrl: string;
	/** The surface this manager is being built to start. */
	startingId: SecondarySurfaceId;
}

interface SurfaceFactory<K extends SecondarySurfaceId> {
	spec(config: SurfaceConfig<K>, context: SurfaceFactoryContext): Promise<SurfaceSpec>;
	/** Config-free spec: a running surface stays stoppable after its config is removed. */
	stopSpec(): SurfaceSpec;
	capability(config: SurfaceConfig<K>, deps: ApiDeps): SurfaceCapability<K>;
}

async function managedAiFor(
	context: SurfaceFactoryContext,
): Promise<OpenCodeManagedAiOptions | undefined> {
	const { deps, session, user, appBaseUrl } = context;
	if (!deps.ai) return undefined;
	try {
		return {
			baseUrl: joinUrlPath(appBaseUrl, '/api/ai/v1'),
			apiKey: await mintAiSessionToken(
				deps.ai.signingSecret,
				{
					projectId: session.project_id,
					notebookId: session.notebook_id,
					sessionId: session.session_id,
					userId: user.id,
				},
				{ ttlSeconds: deps.ai.tokenTtlSeconds },
			),
			model: deps.ai.model,
		};
	} catch (error) {
		logEvent({
			level: 'warn',
			event: 'surface_ai_inject_failed',
			project_id: session.project_id,
			notebook_id: session.notebook_id,
			session_id: session.session_id,
			surface: 'opencode',
			error: errorMetadata(error),
		});
		return undefined;
	}
}

export const SURFACE_FACTORIES: { [K in SecondarySurfaceId]: SurfaceFactory<K> } = {
	vscode: {
		async spec(config) {
			return vscodeSurface({
				flavor: config.flavor,
				port: config.port,
				settings: config.settings,
				extensionGallery: config.extensionGallery,
			});
		},
		stopSpec: () => vscodeSurface(),
		capability: (config) => ({
			id: 'vscode',
			flavor: config.flavor,
			start: config.start,
			embed: config.embed,
		}),
	},
	opencode: {
		async spec(config, context) {
			// The session token is minted only for the surface being started so an
			// unrelated start never spends a token on OpenCode.
			const managedAi = context.startingId === 'opencode' ? await managedAiFor(context) : undefined;
			return opencodeSurface({ port: config.port, managedAi });
		},
		stopSpec: () => opencodeSurface(),
		capability: (config, deps) => ({
			id: 'opencode',
			start: config.start,
			embed: config.embed,
			managed_ai: Boolean(deps.ai),
		}),
	},
};

function specFor<K extends SecondarySurfaceId>(
	id: K,
	config: SurfaceConfig<K>,
	context: SurfaceFactoryContext,
): Promise<SurfaceSpec> {
	return SURFACE_FACTORIES[id].spec(config, context);
}

function capabilityFor<K extends SecondarySurfaceId>(
	id: K,
	config: SurfaceConfig<K>,
	deps: ApiDeps,
): SurfaceCapability<K> {
	return SURFACE_FACTORIES[id].capability(config, deps);
}

export function surfaceConfig(deps: ApiDeps, id: SecondarySurfaceId) {
	const config = deps.sandbox.surfaces?.[id];
	if (!config) throw new SurfaceNotEnabledError(`The ${id} surface is not enabled`);
	return config;
}

/** Enabled surfaces as advertised on `GET /capabilities`, in registry order. */
export function surfaceCapabilities(deps: ApiDeps): SurfaceCapability<SecondarySurfaceId>[] {
	return SECONDARY_SURFACE_IDS.flatMap((id) => {
		const config = deps.sandbox.surfaces?.[id];
		return config ? [capabilityFor(id, config, deps)] : [];
	});
}

async function createSurfaceManager(context: SurfaceFactoryContext): Promise<SurfaceManager> {
	const { deps } = context;
	if (deps.compute.capabilities?.multiPort !== true) {
		throw new SurfaceUnsupportedProviderError(
			'The compute backend cannot expose a second sandbox port',
		);
	}
	const specs: SurfaceSpec[] = [marimoSurface];
	for (const id of SECONDARY_SURFACE_IDS) {
		const config = deps.sandbox.surfaces?.[id];
		if (config) specs.push(await specFor(id, config, context));
	}
	return new SurfaceManager(deps.compute, deps.services.sessions, new SurfaceRegistry(specs));
}

export function surfaceStopManager(deps: ApiDeps): SurfaceManager {
	return new SurfaceManager(
		deps.compute,
		deps.services.sessions,
		new SurfaceRegistry([
			marimoSurface,
			...SECONDARY_SURFACE_IDS.map((id) => SURFACE_FACTORIES[id].stopSpec()),
		]),
	);
}

interface SurfaceStartContext {
	projectId: string;
	notebookId: string;
	sessionId: string;
	surface: SecondarySurfaceId;
}

function logSurfaceStartFailure(context: SurfaceStartContext, error: unknown): void {
	logEvent({
		level: 'warn',
		event: 'surface_start_failed',
		project_id: context.projectId,
		notebook_id: context.notebookId,
		session_id: context.sessionId,
		surface: context.surface,
		error: errorMetadata(error),
	});
}

function deferSurfaceCompletion(
	deps: ApiDeps,
	completion: Promise<unknown> | undefined,
	context: SurfaceStartContext,
): void {
	if (!completion) return;
	const task = completion.catch((error) => logSurfaceStartFailure(context, error));
	if (deps.backgroundTasks) deps.backgroundTasks.defer(task);
	else void task;
}

interface BeginSurfaceInput {
	deps: ApiDeps;
	session: Session;
	user: AuthUser;
	id: SecondarySurfaceId;
	workspaceDir: string;
	exposure: SandboxExposure;
	hostname: string;
	appBaseUrl: string;
	open?: string;
}

export async function beginSessionSurface(input: BeginSurfaceInput) {
	const { deps, session, user, id, workspaceDir, exposure, hostname, appBaseUrl, open } = input;
	const config = surfaceConfig(deps, id);
	let basePath: string | undefined;
	let clientBaseUrl: string | undefined;
	if (exposure instanceof ProxyExposure) {
		const token = await signProxyToken(
			session.project_id,
			session.session_id,
			exposure.signingSecret,
		);
		basePath = `/surface-proxy/${token}/${id}`;
		clientBaseUrl = `${joinUrlPath(appBaseUrl, basePath)}/`;
	}
	const manager = await createSurfaceManager({ deps, user, session, appBaseUrl, startingId: id });
	const begun = await manager.begin(session, id, {
		user,
		workspaceDir,
		port: config.port,
		exposure: exposure.mode,
		hostname,
		clientBaseUrl,
		basePath,
		open,
	});
	deferSurfaceCompletion(deps, begun.completion, {
		projectId: session.project_id,
		notebookId: session.notebook_id,
		sessionId: session.session_id,
		surface: id,
	});
	return begun;
}

export async function beginSessionSurfaces(
	input: Omit<BeginSurfaceInput, 'id' | 'open'> & {
		ids: readonly SecondarySurfaceId[];
	},
): Promise<Session> {
	const { ids, ...shared } = input;
	await Promise.all(
		ids.map(async (id) => {
			try {
				await beginSessionSurface({ ...shared, id });
			} catch (error) {
				logSurfaceStartFailure(
					{
						projectId: input.session.project_id,
						notebookId: input.session.notebook_id,
						sessionId: input.session.session_id,
						surface: id,
					},
					error,
				);
			}
		}),
	);
	return input.deps.services.sessions.getSession(
		input.session.project_id,
		input.session.session_id,
	);
}

export async function loadSurfaceSession(
	deps: ApiDeps,
	user: AuthUser,
	params: { pid: ProjectId; nid: string; sid: SessionId },
	permission: 'attach' | 'control' = 'attach',
) {
	const project = await loadVisibleProject(deps.services.projects, params.pid, user, deps);
	const session = await deps.services.sessions.getSession(params.pid, params.sid);
	if (session.notebook_id !== params.nid) {
		throw new NotFoundError(`Session ${params.sid} not found`);
	}
	const labels = await assertSessionNotebookVisible(deps, project, session, user);
	if (permission === 'control') await assertSessionControl(project, session, user, deps, labels);
	else await assertSessionSurfaceAccess(project, session, user, deps, labels);
	return session;
}
