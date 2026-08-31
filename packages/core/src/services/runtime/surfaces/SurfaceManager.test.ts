import { describe, expect, it, vi } from 'vitest';
import type { SandboxProcess } from '../../../ports/sandbox';
import { createNotebookId, createProjectId, createSandboxId } from '../../../ids';
import { MemoryBucket, ACTOR, fakeComputeFrom, makeFakeSandbox } from '../../../testing';
import { SessionService } from '../SessionService';
import { marimoSurface } from './marimo';
import { opencodeSurface } from './opencode';
import { SurfaceManager } from './SurfaceManager';
import { SurfaceRegistry } from './registry';
import { vscodeSurface } from './vscode';

const user = { id: ACTOR, email: 'owner@example.com' };

async function setup(failWaitForPort?: Error, vscode = vscodeSurface()) {
	const sessions = new SessionService(new MemoryBucket());
	const created = await sessions.createSession({
		project_id: createProjectId(),
		notebook_id: createNotebookId(),
		user_id: ACTOR,
		sandbox_id: createSandboxId(),
	});
	const session = await sessions.setRunning(
		created.project_id,
		created.session_id,
		'https://sandbox.example/marimo',
		false,
	);
	const { instance, calls } = makeFakeSandbox({ failWaitForPort });
	const manager = new SurfaceManager(
		fakeComputeFrom(instance),
		sessions,
		new SurfaceRegistry([marimoSurface, vscode]),
	);
	return { calls, instance, manager, session, sessions };
}

function options() {
	return {
		user,
		workspaceDir: '/workspace',
		exposure: 'subdomain' as const,
		hostname: 'sandbox.example',
		open: 'notebook.py',
	};
}

describe('SurfaceManager', () => {
	it('rejects unsupported exposure and open-path combinations before sandbox work', async () => {
		const { calls, instance, session, sessions } = await setup();
		const manager = new SurfaceManager(
			fakeComputeFrom(instance),
			sessions,
			new SurfaceRegistry([marimoSurface, opencodeSurface()]),
		);

		await expect(
			manager.begin(session, 'opencode', { ...options(), exposure: 'proxy', open: undefined }),
		).rejects.toThrow('does not support proxy exposure');
		await expect(manager.begin(session, 'opencode', options())).rejects.toThrow(
			'does not support an open path',
		);
		expect(calls.exec).toHaveLength(0);
	});

	it('prepares, starts, exposes, and persists a secondary surface once', async () => {
		const { calls, manager, session, sessions } = await setup();

		const first = await manager.ensure(session, 'vscode', { ...options(), open: undefined });
		const second = await manager.ensure(
			await sessions.getSession(session.project_id, session.session_id),
			'vscode',
			options(),
		);

		expect(first.status).toBe('ready');
		expect(second.status).toBe('ready');
		expect(calls.startProcess).toHaveLength(1);
		expect(calls.startProcess[0].cmd).toContain('surface.pid');
		expect(calls.startProcess[0].cmd.match(/cancel-/g)).toHaveLength(2);
		expect(calls.waitForPort).toEqual([8443]);
		expect(calls.exposePort).toEqual([
			{
				port: 8443,
				options: { hostname: 'sandbox.example', token: session.sandbox_id, name: 'vscode' },
			},
		]);
		const stored = await sessions.getSession(session.project_id, session.session_id);
		expect(stored.surfaces?.vscode).toMatchObject({
			status: 'ready',
			port: 8443,
			probe: { available: true },
		});
		const opened = new URL(second.state.url!);
		expect(opened.searchParams.get('folder')).toBe('/workspace');
		expect(opened.searchParams.has('file')).toBe(false);
		expect(JSON.parse(opened.searchParams.get('payload')!)).toEqual([
			['openFile', 'vscode-remote://sandbox.example/workspace/notebook.py'],
		]);
	});

	it('lets a ready surface resolve its application URL from sandbox state', async () => {
		const resolveOpenUrl = vi.fn(async (_instance: unknown, base: URL) => {
			const url = new URL(base);
			url.pathname = '/workspace/session/ses_test';
			return url;
		});
		const { manager, session, sessions } = await setup(undefined, {
			...vscodeSurface(),
			resolveOpenUrl,
		});

		const result = await manager.ensure(session, 'vscode', { ...options(), open: undefined });

		expect(result.state.url).toBe('https://sandbox.example/workspace/session/ses_test');
		expect(resolveOpenUrl).toHaveBeenCalledWith(
			expect.anything(),
			new URL('https://sandbox.example/kernel'),
			expect.objectContaining({ processWorkspaceDir: '/workspace' }),
			{ open: undefined, port: 8443 },
		);
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode?.url,
		).toBe('https://sandbox.example/workspace/session/ses_test');
	});

	it.each([
		'/secrets.txt',
		'../secrets.txt',
		'nested\\..\\secrets.txt',
		'bad\0path',
		'x'.repeat(4097),
	])('rejects invalid open path %j before touching the sandbox', async (open) => {
		const { calls, manager, session } = await setup();

		await expect(manager.ensure(session, 'vscode', { ...options(), open })).rejects.toMatchObject({
			code: 'SURFACE_OPEN_INVALID',
		});
		expect(calls.exec).toHaveLength(0);
	});

	it('rejects an open path whose resolved sandbox path escapes through a symlink', async () => {
		const { calls, instance, manager, session, sessions } = await setup();
		instance.exec = async () => ({
			success: false,
			stdout: '',
			stderr: '',
			error: { code: 'COMMAND_FAILED' },
		});

		await expect(
			manager.ensure(session, 'vscode', { ...options(), open: 'linked/secret.py' }),
		).rejects.toMatchObject({ code: 'SURFACE_OPEN_INVALID' });
		expect(calls.startProcess).toHaveLength(0);
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode,
		).toMatchObject({
			status: 'failed',
			last_error: 'Failed to start vscode (SurfaceOpenInvalidError)',
		});
	});

	it('persists an unavailable probe without preparing or starting a process', async () => {
		const sessions = new SessionService(new MemoryBucket());
		const created = await sessions.createSession({
			project_id: createProjectId(),
			notebook_id: createNotebookId(),
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
		});
		const session = await sessions.setRunning(
			created.project_id,
			created.session_id,
			'https://sandbox.example/marimo',
			false,
		);
		const { instance, calls } = makeFakeSandbox();
		const prepare = vi.fn();
		const vscode = vscodeSurface();
		const manager = new SurfaceManager(
			fakeComputeFrom(instance),
			sessions,
			new SurfaceRegistry([
				marimoSurface,
				{
					...vscode,
					probe: async () => ({ available: false, reason: 'code-server is missing' }),
					prepare,
				},
			]),
		);

		await expect(manager.ensure(session, 'vscode', options())).rejects.toMatchObject({
			code: 'SURFACE_UNAVAILABLE',
		});
		expect(prepare).not.toHaveBeenCalled();
		expect(calls.startProcess).toHaveLength(0);
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode,
		).toEqual({
			status: 'unavailable',
			probe: { available: false, reason: 'code-server is missing' },
			last_error: 'code-server is missing',
		});
	});

	it('persists a sanitized failure when readiness does not complete', async () => {
		const { manager, session, sessions } = await setup(new Error('raw provider details'));

		await expect(manager.ensure(session, 'vscode', options())).rejects.toThrow(
			'raw provider details',
		);
		const stored = await sessions.getSession(session.project_id, session.session_id);
		expect(stored.surfaces?.vscode).toEqual({
			status: 'failed',
			last_error: 'Failed to start vscode (Error)',
		});
	});

	it('does not prepare or launch after stop fences an attempt during its probe', async () => {
		const sessions = new SessionService(new MemoryBucket());
		const created = await sessions.createSession({
			project_id: createProjectId(),
			notebook_id: createNotebookId(),
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
		});
		const session = await sessions.setRunning(
			created.project_id,
			created.session_id,
			'https://sandbox.example/marimo',
			false,
		);
		const { instance, calls } = makeFakeSandbox();
		let enteredProbe!: () => void;
		const probing = new Promise<void>((resolve) => {
			enteredProbe = resolve;
		});
		let finishProbe!: () => void;
		const probed = new Promise<void>((resolve) => {
			finishProbe = resolve;
		});
		const prepare = vi.fn();
		const vscode = vscodeSurface();
		const manager = new SurfaceManager(
			fakeComputeFrom(instance),
			sessions,
			new SurfaceRegistry([
				marimoSurface,
				{
					...vscode,
					probe: async () => {
						enteredProbe();
						await probed;
						return { available: true };
					},
					prepare,
				},
			]),
		);

		const start = manager.ensure(session, 'vscode', options());
		await probing;
		await manager.stop(session, 'vscode');
		expect(calls.exec.at(-1)).toContain('touch');
		expect(calls.exec.at(-1)).toContain('/vscode/cancel-');
		finishProbe();

		await expect(start).rejects.toThrow('cancelled');
		expect(prepare).not.toHaveBeenCalled();
		expect(calls.startProcess).toHaveLength(0);
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode,
		).toEqual({ status: 'stopped' });
	});

	it('does not launch after stop fences an attempt during preparation', async () => {
		const sessions = new SessionService(new MemoryBucket());
		const created = await sessions.createSession({
			project_id: createProjectId(),
			notebook_id: createNotebookId(),
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
		});
		const session = await sessions.setRunning(
			created.project_id,
			created.session_id,
			'https://sandbox.example/marimo',
			false,
		);
		const { instance, calls } = makeFakeSandbox();
		let enteredPrepare!: () => void;
		const preparing = new Promise<void>((resolve) => {
			enteredPrepare = resolve;
		});
		let resumePrepare!: () => void;
		const prepared = new Promise<void>((resolve) => {
			resumePrepare = resolve;
		});
		const vscode = vscodeSurface();
		const manager = new SurfaceManager(
			fakeComputeFrom(instance),
			sessions,
			new SurfaceRegistry([
				marimoSurface,
				{
					...vscode,
					prepare: async () => {
						enteredPrepare();
						await prepared;
					},
				},
			]),
		);

		const start = manager.ensure(session, 'vscode', options());
		await preparing;
		await manager.stop(session, 'vscode');
		resumePrepare();

		await expect(start).rejects.toThrow('cancelled');
		expect(calls.startProcess).toHaveLength(0);
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode,
		).toEqual({ status: 'stopped' });
	});

	it('kills a process launched after stop ran before its PID file existed', async () => {
		const { instance, manager, session, sessions } = await setup();
		let enteredLaunch!: () => void;
		const launching = new Promise<void>((resolve) => {
			enteredLaunch = resolve;
		});
		let finishLaunch!: () => void;
		const launched = new Promise<void>((resolve) => {
			finishLaunch = resolve;
		});
		const kill = vi.fn(async () => {});
		const waitForPort = vi.fn(async () => {});
		instance.startProcess = vi.fn(async () => {
			enteredLaunch();
			await launched;
			return {
				id: 'surface-vscode',
				command: 'code-server',
				kill,
				waitForPort,
				getLogs: async () => ({ stdout: '', stderr: '' }),
			};
		});

		const start = manager.ensure(session, 'vscode', options());
		await launching;
		await manager.stop(await sessions.getSession(session.project_id, session.session_id), 'vscode');
		finishLaunch();

		await expect(start).rejects.toThrow('cancelled');
		expect(kill).toHaveBeenCalledOnce();
		expect(waitForPort).not.toHaveBeenCalled();
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode,
		).toEqual({ status: 'stopped' });
	});

	it('kills a process whose ready transition loses to stop', async () => {
		const sessions = new SessionService(new MemoryBucket());
		const created = await sessions.createSession({
			project_id: createProjectId(),
			notebook_id: createNotebookId(),
			user_id: ACTOR,
			sandbox_id: createSandboxId(),
		});
		const session = await sessions.setRunning(
			created.project_id,
			created.session_id,
			'https://sandbox.example/marimo',
			false,
		);
		const { instance } = makeFakeSandbox();
		let enteredReadiness!: () => void;
		const waiting = new Promise<void>((resolve) => {
			enteredReadiness = resolve;
		});
		let finishReadiness!: () => void;
		const ready = new Promise<void>((resolve) => {
			finishReadiness = resolve;
		});
		const kill = vi.fn(async () => {});
		const process: SandboxProcess = {
			id: 'surface-vscode',
			command: 'code-server',
			kill,
			waitForPort: async () => {
				enteredReadiness();
				await ready;
			},
			getLogs: async () => ({ stdout: '', stderr: '' }),
		};
		instance.startProcess = vi.fn(async () => process);
		const manager = new SurfaceManager(
			fakeComputeFrom(instance),
			sessions,
			new SurfaceRegistry([marimoSurface, vscodeSurface()]),
		);

		const start = manager.ensure(session, 'vscode', options());
		await waiting;
		await manager.stop(session, 'vscode');
		finishReadiness();

		await expect(start).rejects.toThrow('stopped while the surface was starting');
		expect(kill).toHaveBeenCalledOnce();
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode,
		).toEqual({ status: 'stopped' });
	});

	it('returns starting to a concurrent ensure without launching twice', async () => {
		const { instance, manager, session, sessions } = await setup();
		let enteredReadiness!: () => void;
		const waiting = new Promise<void>((resolve) => {
			enteredReadiness = resolve;
		});
		let finishReadiness!: () => void;
		const ready = new Promise<void>((resolve) => {
			finishReadiness = resolve;
		});
		const process: SandboxProcess = {
			id: 'surface-vscode',
			command: 'code-server',
			kill: async () => {},
			waitForPort: async () => {
				enteredReadiness();
				await ready;
			},
			getLogs: async () => ({ stdout: '', stderr: '' }),
		};
		const startProcess = vi.fn(async () => process);
		instance.startProcess = startProcess;

		const first = manager.ensure(session, 'vscode', options());
		await waiting;
		const concurrent = await manager.ensure(
			await sessions.getSession(session.project_id, session.session_id),
			'vscode',
			options(),
		);

		expect(concurrent).toMatchObject({ status: 'starting', state: { status: 'starting' } });
		expect(startProcess).toHaveBeenCalledOnce();
		finishReadiness();
		await expect(first).resolves.toMatchObject({ status: 'ready' });
	});

	it('keeps a fresh starting lease instead of launching twice', async () => {
		const { calls, manager, session, sessions } = await setup();
		await sessions.setSurfaceState(session.project_id, session.session_id, 'vscode', {
			status: 'starting',
			attempt_id: 'attempt-live',
			attempt_started_at: new Date().toISOString(),
		});

		const result = await manager.ensure(
			await sessions.getSession(session.project_id, session.session_id),
			'vscode',
			options(),
		);

		expect(result).toMatchObject({
			status: 'starting',
			state: { attempt_id: 'attempt-live' },
		});
		expect(calls.exec).toHaveLength(0);
		expect(calls.startProcess).toHaveLength(0);
	});

	it('takes over an expired starting lease and cleans up its orphan process first', async () => {
		const { calls, manager, session, sessions } = await setup();
		await sessions.setSurfaceState(session.project_id, session.session_id, 'vscode', {
			status: 'starting',
			attempt_id: 'attempt-abandoned',
			attempt_started_at: new Date(Date.now() - 4 * 60_000).toISOString(),
		});

		const result = await manager.ensure(
			await sessions.getSession(session.project_id, session.session_id),
			'vscode',
			options(),
		);

		expect(result.status).toBe('ready');
		expect(calls.exec[0]).toContain('/vscode/surface.pid');
		expect(calls.exec[1]).toContain('os.path.realpath');
		expect(calls.startProcess).toHaveLength(1);
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode,
		).toMatchObject({ status: 'ready', proxy_path: 'strip-prefix' });
	});

	it('takes over a legacy starting attempt that has no lease timestamp', async () => {
		const { calls, manager, session, sessions } = await setup();
		await sessions.setSurfaceState(session.project_id, session.session_id, 'vscode', {
			status: 'starting',
			attempt_id: 'attempt-before-leases',
		});

		const result = await manager.ensure(
			await sessions.getSession(session.project_id, session.session_id),
			'vscode',
			{ ...options(), open: undefined },
		);

		expect(result.status).toBe('ready');
		expect(calls.exec[0]).toContain('/vscode/surface.pid');
		expect(calls.startProcess).toHaveLength(1);
	});

	it('uses the workspace path visible to the editor process in the open URL', async () => {
		const { calls, instance, manager, session } = await setup();
		instance.resolveProcessPath = () => '/tmp/local sandbox/workspace';

		const result = await manager.ensure(session, 'vscode', options());
		const url = new URL(result.state.url!);

		expect(url.searchParams.get('folder')).toBe('/tmp/local sandbox/workspace');
		expect(JSON.parse(url.searchParams.get('payload')!)).toEqual([
			['openFile', 'vscode-remote://sandbox.example/tmp/local%20sandbox/workspace/notebook.py'],
		]);
		expect(JSON.parse(String(calls.writeFile[0].content))).toMatchObject({
			'python.defaultInterpreterPath': '/tmp/local sandbox/workspace/.venv/bin/python',
		});
	});

	it('checks OpenVSCode readiness beneath its configured proxy base path', async () => {
		const { calls, manager, session } = await setup(
			undefined,
			vscodeSurface({ flavor: 'openvscode' }),
		);

		await manager.ensure(session, 'vscode', {
			...options(),
			exposure: 'proxy',
			basePath: '/surface-proxy/token/vscode',
		});

		expect(calls.waitForPortOptions.at(-1)).toMatchObject({
			mode: 'http',
			path: '/surface-proxy/token/vscode/',
		});
	});

	it('restarts a ready surface when its process is no longer healthy', async () => {
		const { calls, instance, manager, session, sessions } = await setup();
		await manager.ensure(session, 'vscode', { ...options(), open: undefined });
		const exec = instance.exec.bind(instance);
		let failedHealthCheck = false;
		instance.exec = async (cmd, execOptions) => {
			if (!failedHealthCheck && cmd.includes('kill -0') && !cmd.includes('kill -TERM')) {
				failedHealthCheck = true;
				return {
					success: false,
					stdout: '',
					stderr: '',
					error: { code: 'COMMAND_FAILED' },
				};
			}
			return exec(cmd, execOptions);
		};

		const result = await manager.ensure(
			await sessions.getSession(session.project_id, session.session_id),
			'vscode',
			options(),
		);

		expect(result.status).toBe('ready');
		expect(failedHealthCheck).toBe(true);
		expect(calls.startProcess).toHaveLength(2);
	});

	it('restarts an alive surface when its HTTP endpoint is no longer ready', async () => {
		const { calls, instance, manager, session, sessions } = await setup();
		await manager.ensure(session, 'vscode', { ...options(), open: undefined });
		instance.isPortReady = vi.fn(async () => false);

		const result = await manager.ensure(
			await sessions.getSession(session.project_id, session.session_id),
			'vscode',
			options(),
		);

		expect(result.status).toBe('ready');
		expect(instance.isPortReady).toHaveBeenCalledWith(8443, {
			mode: 'http',
			path: '/healthz',
		});
		expect(calls.startProcess).toHaveLength(2);
	});

	it('does not commit stopped while process termination is pending', async () => {
		const { calls, instance, manager, session, sessions } = await setup();
		await manager.ensure(session, 'vscode', options());
		const exec = instance.exec.bind(instance);
		let enteredStop!: () => void;
		const stopping = new Promise<void>((resolve) => {
			enteredStop = resolve;
		});
		let finishStop!: () => void;
		const stopped = new Promise<void>((resolve) => {
			finishStop = resolve;
		});
		instance.exec = async (cmd, execOptions) => {
			if (cmd.includes('kill -TERM')) {
				enteredStop();
				await stopped;
			}
			return exec(cmd, execOptions);
		};
		const current = await sessions.getSession(session.project_id, session.session_id);

		const stop = manager.stop(current, 'vscode');
		await stopping;
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode,
		).toMatchObject({ status: 'stopping', attempt_id: expect.any(String) });
		finishStop();
		await stop;
		expect(calls.exec.at(-1)).toContain('then exit 1');
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode,
		).toEqual({ status: 'stopped' });
	});

	it('allows only the CAS owner to run and complete a concurrent stop', async () => {
		const { instance, manager, session, sessions } = await setup();
		await manager.ensure(session, 'vscode', options());
		const exec = instance.exec.bind(instance);
		let enteredStop!: () => void;
		const stopping = new Promise<void>((resolve) => {
			enteredStop = resolve;
		});
		let finishStop!: () => void;
		const stopped = new Promise<void>((resolve) => {
			finishStop = resolve;
		});
		let stopCommands = 0;
		instance.exec = async (cmd, execOptions) => {
			if (cmd.includes('kill -TERM')) {
				stopCommands += 1;
				if (stopCommands === 1) {
					enteredStop();
					await stopped;
				}
			}
			return exec(cmd, execOptions);
		};
		const current = await sessions.getSession(session.project_id, session.session_id);
		const first = manager.stop(current, 'vscode');
		await stopping;

		const concurrent = await manager.stop(current, 'vscode').catch((error: unknown) => error);
		finishStop();
		await first;
		expect(concurrent).toMatchObject({ code: 'CONFLICT' });
		expect(stopCommands).toBe(1);
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode,
		).toEqual({ status: 'stopped' });
	});

	it('does not report a failed stop command as stopped', async () => {
		const { instance, manager, session, sessions } = await setup();
		await manager.ensure(session, 'vscode', options());
		const exec = instance.exec.bind(instance);
		instance.exec = async (cmd, execOptions) => {
			if (cmd.includes('kill -TERM')) {
				return {
					success: false,
					stdout: '',
					stderr: 'permission denied',
					error: { code: 'COMMAND_FAILED' },
				};
			}
			return exec(cmd, execOptions);
		};
		const current = await sessions.getSession(session.project_id, session.session_id);

		await expect(manager.stop(current, 'vscode')).rejects.toMatchObject({
			code: 'SERVICE_UNAVAILABLE',
		});
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode,
		).toEqual({ status: 'failed', last_error: 'Failed to stop vscode' });
	});

	it('rejects a restart while a stop is in progress', async () => {
		const { calls, manager, session, sessions } = await setup();
		await sessions.setSurfaceState(session.project_id, session.session_id, 'vscode', {
			status: 'stopping',
		});

		await expect(manager.ensure(session, 'vscode', options())).rejects.toMatchObject({
			code: 'CONFLICT',
		});
		expect(calls.startProcess).toHaveLength(0);
	});

	it('does not let an old starter overwrite a replacement attempt', async () => {
		const { instance, manager, session, sessions } = await setup();
		let firstEntered!: () => void;
		const firstWaiting = new Promise<void>((resolve) => {
			firstEntered = resolve;
		});
		let finishFirst!: () => void;
		const firstReady = new Promise<void>((resolve) => {
			finishFirst = resolve;
		});
		const firstKill = vi.fn(async () => {});
		const secondKill = vi.fn(async () => {});
		const processes: SandboxProcess[] = [
			{
				id: 'surface-vscode-1',
				command: 'code-server',
				kill: firstKill,
				waitForPort: async () => {
					firstEntered();
					await firstReady;
				},
				getLogs: async () => ({ stdout: '', stderr: '' }),
			},
			{
				id: 'surface-vscode-2',
				command: 'code-server',
				kill: secondKill,
				waitForPort: async () => {},
				getLogs: async () => ({ stdout: '', stderr: '' }),
			},
		];
		instance.startProcess = vi.fn(async () => processes.shift()!);

		const first = manager.ensure(session, 'vscode', options());
		await firstWaiting;
		await manager.stop(session, 'vscode');
		const replacement = await manager.ensure(
			await sessions.getSession(session.project_id, session.session_id),
			'vscode',
			options(),
		);
		expect(replacement.status).toBe('ready');

		finishFirst();
		await expect(first).rejects.toThrow('stopped while the surface was starting');
		expect(firstKill).toHaveBeenCalledOnce();
		expect(secondKill).not.toHaveBeenCalled();
		expect(
			(await sessions.getSession(session.project_id, session.session_id)).surfaces?.vscode,
		).toMatchObject({ status: 'ready', port: 8443 });
	});
});
