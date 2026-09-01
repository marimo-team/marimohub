import type {
	AuthUser,
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
	signProxyToken,
	SurfaceManager,
	SurfaceNotEnabledError,
	SurfaceRegistry,
	SurfaceUnsupportedProviderError,
	vscodeSurface,
} from '@marimo-hub/core';
import type { ApiDeps } from '../context';
import { errorMetadata, logEvent } from '../log';
import { assertSessionControl, assertSessionSurfaceAccess, loadVisibleProject } from '../shared';

export function surfaceConfig(deps: ApiDeps, id: SecondarySurfaceId) {
	const config = deps.sandbox.surfaces?.[id];
	if (!config) throw new SurfaceNotEnabledError(`The ${id} surface is not enabled`);
	return config;
}

async function createSurfaceManager(
	deps: ApiDeps,
	startingId: SecondarySurfaceId,
	context: { user: AuthUser; session: Session; appBaseUrl: string },
): Promise<SurfaceManager> {
	if (deps.compute.capabilities?.multiPort !== true) {
		throw new SurfaceUnsupportedProviderError(
			'The compute backend cannot expose a second sandbox port',
		);
	}
	const specs: SurfaceSpec[] = [marimoSurface];
	const vscodeConfig = deps.sandbox.surfaces?.vscode;
	if (vscodeConfig) {
		specs.push(
			vscodeSurface({
				flavor: vscodeConfig.flavor,
				port: vscodeConfig.port,
				settings: vscodeConfig.settings,
				extensionGallery: vscodeConfig.extensionGallery,
			}),
		);
	}
	const openCodeConfig = deps.sandbox.surfaces?.opencode;
	if (openCodeConfig) {
		let managedAi;
		if (deps.ai && startingId === 'opencode') {
			try {
				managedAi = {
					baseUrl: joinUrlPath(context.appBaseUrl, '/api/ai/v1'),
					apiKey: await mintAiSessionToken(
						deps.ai.signingSecret,
						{
							projectId: context.session.project_id,
							notebookId: context.session.notebook_id,
							sessionId: context.session.session_id,
							userId: context.user.id,
						},
						{ ttlSeconds: deps.ai.tokenTtlSeconds },
					),
					model: deps.ai.model,
				};
			} catch (error) {
				logEvent({
					level: 'warn',
					event: 'surface_ai_inject_failed',
					project_id: context.session.project_id,
					notebook_id: context.session.notebook_id,
					session_id: context.session.session_id,
					surface: 'opencode',
					error: errorMetadata(error),
				});
			}
		}
		specs.push(
			opencodeSurface({
				port: openCodeConfig.port,
				managedAi,
			}),
		);
	}
	return new SurfaceManager(deps.compute, deps.services.sessions, new SurfaceRegistry(specs));
}

export function surfaceStopManager(deps: ApiDeps): SurfaceManager {
	return new SurfaceManager(
		deps.compute,
		deps.services.sessions,
		new SurfaceRegistry([marimoSurface, vscodeSurface(), opencodeSurface()]),
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
	const manager = await createSurfaceManager(deps, id, { user, session, appBaseUrl });
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
	const project = await loadVisibleProject(deps.services.projects, params.pid, user, deps.policy);
	const session = await deps.services.sessions.getSession(params.pid, params.sid);
	if (session.notebook_id !== params.nid) {
		throw new NotFoundError(`Session ${params.sid} not found`);
	}
	if (permission === 'control') await assertSessionControl(project, session, user, deps.policy);
	else await assertSessionSurfaceAccess(project, session, user, deps.policy);
	return session;
}
