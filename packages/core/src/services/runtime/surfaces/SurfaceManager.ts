import type { AuthUser } from '../../../ports/auth';
import type { SandboxProcess, SandboxProvider } from '../../../ports/sandbox';
import type { Session } from '../../../schema';
import {
	ConflictError,
	SurfaceOpenInvalidError,
	SurfacePrimaryError,
	SurfaceUnavailableError,
	UnavailableError,
} from '../../../errors';
import type { SessionService } from '../SessionService';
import { shellQuote } from '../shell';
import type { SurfaceContext, SurfaceId, SurfaceSpec } from './types';
import type { SurfaceRegistry } from './registry';

export interface EnsureSurfaceOptions {
	user: AuthUser;
	workspaceDir: string;
	notebookFile?: string;
	port?: number;
	exposure: 'proxy' | 'subdomain';
	hostname: string;
	clientBaseUrl?: string;
	basePath?: string;
	open?: string;
}

export type EnsureSurfaceResult =
	| { status: 'starting'; state: NonNullable<Session['surfaces']>[string] }
	| { status: 'ready'; state: NonNullable<Session['surfaces']>[string] };

export interface BeginSurfaceResult {
	result: EnsureSurfaceResult;
	completion?: Promise<EnsureSurfaceResult>;
}

function commandLine(parts: readonly string[]): string {
	return parts.map(shellQuote).join(' ');
}

function validateOpenPath(open: string | undefined): void {
	if (!open) return;
	if (open.length > 4096 || open.includes('\0') || open.startsWith('/')) {
		throw new SurfaceOpenInvalidError('Surface open path must be relative to the workspace');
	}
	const segments = open.replaceAll('\\', '/').split('/');
	if (segments.includes('..')) {
		throw new SurfaceOpenInvalidError('Surface open path must stay inside the workspace');
	}
}

async function validateOpenInSandbox(
	instance: ReturnType<SandboxProvider['create']>,
	workspaceDir: string,
	open: string | undefined,
): Promise<void> {
	if (!open) return;
	const script =
		'import os,sys; root=os.path.realpath(sys.argv[1]); target=os.path.realpath(os.path.join(root,sys.argv[2])); sys.exit(0 if os.path.commonpath([root,target]) == root else 1)';
	const result = await instance.exec(
		`python3 -c ${shellQuote(script)} ${shellQuote(workspaceDir)} ${shellQuote(open)}`,
		{ timeout: 10_000 },
	);
	if (!result.success) throw new SurfaceOpenInvalidError('Surface open path escapes the workspace');
}

function stopProcessCommand(pidFile: string, requirePid = false): string {
	return `if test ! -f ${shellQuote(pidFile)}; then ${requirePid ? 'exit 1' : 'exit 0'}; fi; pid="$(cat ${shellQuote(pidFile)})"; case "$pid" in ''|*[!0-9]*) exit 1;; esac; kill -TERM "$pid" 2>/dev/null || true; i=0; while kill -0 "$pid" 2>/dev/null && test "$i" -lt 10; do sleep 0.5; i=$((i+1)); done; kill -KILL "$pid" 2>/dev/null || true; sleep 0.1; kill -0 "$pid" 2>/dev/null && exit 1; rm -f ${shellQuote(pidFile)}`;
}

function processAliveCommand(pidFile: string): string {
	return `test -f ${shellQuote(pidFile)} && pid="$(cat ${shellQuote(pidFile)})" && case "$pid" in ''|*[!0-9]*) exit 1;; esac && kill -0 "$pid" 2>/dev/null`;
}

async function surfaceIsReady(
	instance: ReturnType<SandboxProvider['create']>,
	pidFile: string,
	port: number | undefined,
	path: string,
): Promise<boolean> {
	if (port === undefined) return false;
	const alive = await instance.exec(processAliveCommand(pidFile), { timeout: 5_000 });
	if (!alive.success) return false;
	if (instance.isPortReady) {
		return instance.isPortReady(port, { mode: 'http', path });
	}
	const script =
		'import sys,urllib.request; response=urllib.request.urlopen(sys.argv[1], timeout=2); response.close()';
	const ready = await instance.exec(
		`python3 -c ${shellQuote(script)} ${shellQuote(`http://127.0.0.1:${port}${path}`)}`,
		{ timeout: 5_000 },
	);
	return ready.success;
}

function surfaceReadinessPath(spec: SurfaceSpec, context: SurfaceContext): string {
	if (spec.proxyPath !== 'preserve-prefix' || !context.basePath) return spec.readiness.path;
	const base = context.basePath.replace(/\/$/, '');
	return spec.readiness.path === '/' ? `${base}/` : `${base}${spec.readiness.path}`;
}

export class SurfaceManager {
	constructor(
		private readonly provider: SandboxProvider,
		private readonly sessions: SessionService,
		private readonly registry: SurfaceRegistry,
	) {}

	async ensure(
		session: Session,
		id: SurfaceId,
		options: EnsureSurfaceOptions,
	): Promise<EnsureSurfaceResult> {
		const begun = await this.begin(session, id, options);
		return begun.completion ?? begun.result;
	}

	async begin(
		session: Session,
		id: SurfaceId,
		options: EnsureSurfaceOptions,
	): Promise<BeginSurfaceResult> {
		if (session.status !== 'running' || !session.sandbox_id) {
			throw new ConflictError('The sandbox must be running before a surface can start');
		}
		const spec = this.secondary(id);
		validateOpenPath(options.open);
		const instance = this.provider.create(session.sandbox_id);
		const context: SurfaceContext = {
			sessionId: session.session_id,
			projectId: session.project_id,
			notebookId: session.notebook_id,
			workspaceDir: options.workspaceDir,
			processWorkspaceDir:
				instance.resolveProcessPath?.(options.workspaceDir) ?? options.workspaceDir,
			notebookFile: options.notebookFile ?? 'notebook.py',
			user: options.user,
			editIntent: session.ephemeral ? ('temporary' as const) : ('persistent' as const),
			exposure: options.exposure,
			basePath: options.basePath,
			userDataDir: `/tmp/.marimohub/surfaces/${session.session_id}/${id}`,
		};
		const pidFile = `${context.userDataDir}/surface.pid`;
		const readinessPath = surfaceReadinessPath(spec, context);
		let begun = await this.sessions.beginSurfaceStart(session.project_id, session.session_id, id);
		let current = begun.session.surfaces?.[id];
		if (!begun.transitioned && current?.status === 'ready') {
			if (await surfaceIsReady(instance, pidFile, current.port, readinessPath)) {
				const state =
					options.open && current.url
						? {
								...current,
								url: spec.openUrl(new URL(current.url), context, { open: options.open }).toString(),
							}
						: current;
				return { result: { status: 'ready', state } };
			}
			begun = await this.sessions.beginSurfaceStart(session.project_id, session.session_id, id, {
				replaceReady: { startedAt: current.started_at, url: current.url },
			});
			current = begun.session.surfaces?.[id];
		}
		if (!begun.transitioned) {
			if (begun.session.status !== 'running') {
				throw new ConflictError('The sandbox is no longer running');
			}
			if (current?.status === 'stopping') {
				throw new ConflictError('The surface is stopping');
			}
			return {
				result: { status: 'starting', state: current ?? { status: 'starting' } },
			};
		}
		const attemptId = begun.attemptId!;
		const result: EnsureSurfaceResult = {
			status: 'starting',
			state: current ?? {
				status: 'starting',
				attempt_id: attemptId,
				attempt_started_at: new Date().toISOString(),
			},
		};
		const completion = this.completeStart({
			session,
			id,
			options,
			spec,
			instance,
			context,
			readinessPath,
			attemptId,
			cleanupExistingProcess: begun.cleanupExistingProcess ?? false,
		});
		return { result, completion };
	}

	private async completeStart(input: {
		session: Session;
		id: SurfaceId;
		options: EnsureSurfaceOptions;
		spec: SurfaceSpec;
		instance: ReturnType<SandboxProvider['create']>;
		context: SurfaceContext;
		readinessPath: string;
		attemptId: string;
		cleanupExistingProcess: boolean;
	}): Promise<EnsureSurfaceResult> {
		const {
			session,
			id,
			options,
			spec,
			instance,
			context,
			readinessPath,
			attemptId,
			cleanupExistingProcess,
		} = input;
		let process: SandboxProcess | undefined;
		try {
			const pidFile = `${context.userDataDir}/surface.pid`;
			if (cleanupExistingProcess) {
				const stopped = await instance.exec(stopProcessCommand(pidFile), { timeout: 10_000 });
				if (!stopped.success) {
					throw new UnavailableError(`Failed to replace the existing ${id} process`);
				}
			}
			await validateOpenInSandbox(instance, options.workspaceDir, options.open);
			const probe = await spec.probe(instance);
			if (!probe.available) {
				await this.sessions.setSurfaceStateForAttempt(
					session.project_id,
					session.session_id,
					id,
					attemptId,
					{
						status: 'unavailable',
						probe,
						last_error: probe.reason,
					},
				);
				throw new SurfaceUnavailableError(probe.reason ?? `Surface ${id} is unavailable`);
			}
			const afterProbe = await this.sessions.getSession(session.project_id, session.session_id);
			const probedAttempt = afterProbe.surfaces?.[id];
			if (probedAttempt?.status !== 'starting' || probedAttempt.attempt_id !== attemptId) {
				throw new ConflictError('The surface start was cancelled');
			}
			await spec.prepare?.(instance, context);
			const beforeLaunch = await this.sessions.getSession(session.project_id, session.session_id);
			const currentAttempt = beforeLaunch.surfaces?.[id];
			if (currentAttempt?.status !== 'starting' || currentAttempt.attempt_id !== attemptId) {
				throw new ConflictError('The surface start was cancelled');
			}
			const port = options.port ?? spec.defaultPort;
			const launch = spec.command(context, port);
			process = await instance.startProcess(
				`mkdir -p ${shellQuote(context.userDataDir)} && echo $$ > ${shellQuote(pidFile)} && exec ${commandLine(launch.cmd)}`,
				{ cwd: context.workspaceDir, env: launch.env, processId: `surface-${id}` },
			);
			const afterLaunch = await this.sessions.getSession(session.project_id, session.session_id);
			const launchedAttempt = afterLaunch.surfaces?.[id];
			if (launchedAttempt?.status !== 'starting' || launchedAttempt.attempt_id !== attemptId) {
				throw new ConflictError('The surface start was cancelled');
			}
			await process.waitForPort(port, {
				mode: 'http',
				path: readinessPath,
				timeout: spec.readiness.timeoutMs,
			});
			const exposed = await instance.exposePort(port, {
				hostname: options.hostname,
				token: session.sandbox_id,
				name: id,
			});
			const publicBase = options.clientBaseUrl ?? exposed.url;
			const url = spec.openUrl(new URL(publicBase), context, { open: options.open }).toString();
			const state = {
				status: 'ready' as const,
				port,
				url,
				...(options.exposure === 'proxy' ? { origin_url: exposed.url } : {}),
				proxy_path: spec.proxyPath,
				started_at: new Date().toISOString(),
				probe,
			};
			const persisted = await this.sessions.setSurfaceStateForAttempt(
				session.project_id,
				session.session_id,
				id,
				attemptId,
				state,
			);
			if (!persisted.transitioned) {
				throw new ConflictError('The sandbox stopped while the surface was starting');
			}
			return { status: 'ready', state };
		} catch (error) {
			await process?.kill().catch(() => {});
			if (!(error instanceof SurfaceUnavailableError)) {
				await this.sessions
					.setSurfaceStateForAttempt(session.project_id, session.session_id, id, attemptId, {
						status: 'failed',
						last_error: `Failed to start ${id}${error instanceof Error ? ` (${error.name})` : ''}`,
					})
					.catch(() => {});
			}
			throw error;
		}
	}

	async stop(session: Session, id: SurfaceId): Promise<void> {
		this.secondary(id);
		const current = await this.sessions.getSession(session.project_id, session.session_id);
		if (!current.sandbox_id) throw new ConflictError('The session has no sandbox');
		const pidFile = `/tmp/.marimohub/surfaces/${session.session_id}/${id}/surface.pid`;
		const instance = this.provider.create(current.sandbox_id);
		await this.sessions.setSurfaceState(session.project_id, session.session_id, id, {
			status: 'stopping',
		});
		try {
			const stopped = await instance.exec(
				stopProcessCommand(pidFile, current.surfaces?.[id]?.status === 'ready'),
				{ timeout: 10_000 },
			);
			if (!stopped.success) throw new Error('stop command failed');
		} catch (cause) {
			await this.sessions.setSurfaceState(session.project_id, session.session_id, id, {
				status: 'failed',
				last_error: `Failed to stop ${id}`,
			});
			throw new UnavailableError(`Failed to stop ${id}`, { cause });
		}
		await this.sessions.setSurfaceState(session.project_id, session.session_id, id, {
			status: 'stopped',
		});
	}

	private secondary(id: SurfaceId): SurfaceSpec {
		const spec = this.registry.get(id);
		if (spec.primary) throw new SurfacePrimaryError();
		return spec;
	}
}
