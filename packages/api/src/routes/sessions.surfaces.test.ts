import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServices, ProxyExposure } from '@marimo-hub/core';
import type { NotebookId, ProjectId, Session } from '@marimo-hub/core';
import {
	ACTOR,
	fakeComputeFrom,
	makeFakeCompute,
	makeFakeSandbox,
	uid,
} from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import type { ApiDeps } from '../context';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';

const STRANGER = uid('user_stranger');
const MANAGER = uid('user_manager');

type SurfacesConfig = NonNullable<ApiDeps['sandbox']['surfaces']>;

type ApiSession = Session & {
	can: { attach: boolean; stop: boolean; surfaces?: { vscode: boolean; opencode: boolean } };
	reused?: boolean;
};

describe('Session surface routes', () => {
	let bucket: MemoryBucket;
	let owner: ReturnType<typeof createTestApi>['request'];
	let pid: ProjectId;
	let nid: NotebookId;

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		const services = createServices(bucket);
		const project = await services.projects.createProject(
			{ name: 'Owned', description: 'd' },
			ACTOR,
		);
		pid = project.id as ProjectId;
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'NB', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		nid = notebook.id as NotebookId;
		owner = createTestApi({ bucket, userId: ACTOR, compute: makeFakeCompute() }).request;
	});

	const sessionsPath = (suffix = '') => `/projects/${pid}/notebooks/${nid}/sessions${suffix}`;
	const sandboxConfig = (overrides: Partial<ApiDeps['sandbox']> = {}): ApiDeps['sandbox'] => ({
		bucket: { name: 'test', endpoint: '' },
		hostname: 'localhost',
		workdir: '/workspace',
		persistWorkspace: 'source',
		...overrides,
	});
	const multiPort = { capabilities: { multiPort: true } } as const;
	const vscodeSurfaceConfig = (
		overrides: Partial<SurfacesConfig['vscode']> = {},
	): NonNullable<SurfacesConfig['vscode']> => ({
		flavor: 'code-server',
		start: 'on-demand',
		port: 8443,
		settings: {},
		extensionGallery: 'openvsx',
		embed: 'tab',
		...overrides,
	});
	const opencodeSurfaceConfig = (
		overrides: Partial<SurfacesConfig['opencode']> = {},
	): NonNullable<SurfacesConfig['opencode']> => ({
		start: 'on-demand',
		port: 4096,
		embed: 'tab',
		...overrides,
	});

	it('starts, reports, and stops a VS Code surface on an edit sandbox', async () => {
		const { instance, calls } = makeFakeSandbox();
		const compute = fakeComputeFrom(instance, multiPort);
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute,
			deps: {
				sandbox: sandboxConfig({
					surfaces: {
						vscode: vscodeSurfaceConfig(),
					},
				}),
			},
		}).request;
		const session = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		const path = sessionsPath(`/${session.session_id}/surfaces/vscode`);

		const surface = await expectOk<{ status: string; url?: string }>(
			await request('POST', path, { open: 'notebook.py' }),
			202,
		);
		expect(surface).toMatchObject({ status: 'starting' });
		await vi.waitFor(async () => {
			expect(await expectOk(await request('GET', path))).toMatchObject({
				status: 'ready',
				url: expect.stringContaining('folder='),
			});
		});
		expect(calls.exposePort.at(-1)?.port).toBe(8443);
		expect(calls.startProcess.at(-1)?.cmd).toContain('code-server');

		const exec = instance.exec.bind(instance);
		instance.exec = async (cmd, execOptions) =>
			cmd.includes('kill -TERM')
				? {
						success: false,
						stdout: '',
						stderr: 'permission denied',
						error: { code: 'COMMAND_FAILED' },
					}
				: exec(cmd, execOptions);
		await expectError(await request('DELETE', path), 503, 'SERVICE_UNAVAILABLE');
		expect(await expectOk(await request('GET', path))).toMatchObject({
			status: 'failed',
			last_error: 'Failed to stop vscode',
		});
		instance.exec = exec;
		await expectOk(await request('DELETE', path));
		expect(calls.exec.at(-1)).toContain('/vscode/surface.pid');
	});

	it('returns 202 without waiting for VS Code readiness', async () => {
		const { instance } = makeFakeSandbox();
		let finishReadiness!: () => void;
		const readiness = new Promise<void>((resolve) => {
			finishReadiness = resolve;
		});
		const deferred: Promise<unknown>[] = [];
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(instance, multiPort),
			deps: {
				backgroundTasks: { defer: (task) => deferred.push(task) },
				sandbox: sandboxConfig({
					surfaces: {
						vscode: vscodeSurfaceConfig(),
					},
				}),
			},
		}).request;
		const session = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		instance.startProcess = vi.fn(async () => ({
			id: 'surface-vscode',
			command: 'code-server',
			kill: async () => {},
			waitForPort: async () => readiness,
			getLogs: async () => ({ stdout: '', stderr: '' }),
		}));
		const path = sessionsPath(`/${session.session_id}/surfaces/vscode`);

		const starting = await expectOk<{ status: string }>(await request('POST', path), 202);

		expect(starting.status).toBe('starting');
		expect(deferred).toHaveLength(1);
		expect(await expectOk(await request('GET', path))).toMatchObject({ status: 'starting' });
		finishReadiness();
		await Promise.all(deferred);
		expect(await expectOk(await request('GET', path))).toMatchObject({ status: 'ready' });
	});

	it('reports a deferred startup failure through the surface status', async () => {
		const { instance } = makeFakeSandbox();
		const deferred: Promise<unknown>[] = [];
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(instance, multiPort),
			deps: {
				backgroundTasks: { defer: (task) => deferred.push(task) },
				sandbox: sandboxConfig({
					surfaces: {
						vscode: vscodeSurfaceConfig(),
					},
				}),
			},
		}).request;
		const session = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		instance.startProcess = vi.fn(async () => ({
			id: 'surface-vscode',
			command: 'code-server',
			kill: async () => {},
			waitForPort: async () => {
				throw new Error('readiness failed');
			},
			getLogs: async () => ({ stdout: '', stderr: '' }),
		}));
		const path = sessionsPath(`/${session.session_id}/surfaces/vscode`);

		await expectOk(await request('POST', path), 202);
		await Promise.all(deferred);

		expect(await expectOk(await request('GET', path))).toMatchObject({
			status: 'failed',
			last_error: 'Failed to start vscode (Error)',
		});
	});

	it('lets a manager stop an exclusive surface after VS Code is disabled', async () => {
		await createServices(bucket).projects.addMember(pid, { user_id: MANAGER }, 'manager', ACTOR);
		const { instance, calls } = makeFakeSandbox();
		const compute = fakeComputeFrom(instance, multiPort);
		const ownerRequest = createTestApi({
			bucket,
			userId: ACTOR,
			compute,
			deps: {
				policy: { editorSandboxSharing: 'exclusive' },
				sandbox: sandboxConfig({
					surfaces: {
						vscode: vscodeSurfaceConfig(),
					},
				}),
			},
		}).request;
		const session = await expectOk<ApiSession>(await ownerRequest('POST', sessionsPath()));
		const path = sessionsPath(`/${session.session_id}/surfaces/vscode`);
		await expectOk(await ownerRequest('POST', path), 202);
		await vi.waitFor(async () => {
			expect(
				(await createServices(bucket).sessions.getSession(pid, session.session_id)).surfaces?.vscode
					?.status,
			).toBe('ready');
		});
		const managerRequest = createTestApi({
			bucket,
			userId: MANAGER,
			compute,
			deps: { policy: { editorSandboxSharing: 'exclusive' } },
		}).request;

		await expectOk(await managerRequest('DELETE', path));

		expect(calls.exec.at(-1)).toContain('/vscode/surface.pid');
		expect(
			(await createServices(bucket).sessions.getSession(pid, session.session_id)).surfaces?.vscode,
		).toEqual({ status: 'stopped' });
	});

	it('rejects an on-demand start on a single-port compute backend', async () => {
		const { instance, calls } = makeFakeSandbox();
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(instance),
			deps: { sandbox: sandboxConfig({ surfaces: { vscode: vscodeSurfaceConfig() } }) },
		}).request;
		const session = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		const processCount = calls.startProcess.length;

		await expectError(
			await request('POST', sessionsPath(`/${session.session_id}/surfaces/vscode`)),
			409,
			'SURFACE_UNSUPPORTED_PROVIDER',
		);
		expect(calls.startProcess).toHaveLength(processCount);
		expect(
			(await createServices(bucket).sessions.getSession(pid, session.session_id)).surfaces?.vscode,
		).toBeUndefined();
	});

	it('exposes an on-demand surface on the request host when no sandbox hostname is set', async () => {
		const { instance, calls } = makeFakeSandbox();
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(instance, multiPort),
			deps: {
				sandbox: sandboxConfig({ hostname: '', surfaces: { vscode: vscodeSurfaceConfig() } }),
			},
		}).request;
		const session = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		const path = sessionsPath(`/${session.session_id}/surfaces/vscode`);

		await expectOk(await request('POST', path), 202);
		await vi.waitFor(async () => {
			expect(await expectOk(await request('GET', path))).toMatchObject({ status: 'ready' });
		});

		const hostnames = calls.exposePort.map((call) => call.options?.hostname);
		expect(hostnames).toEqual(['localhost', 'localhost']);
	});

	it('runs marimo with --watch only when a secondary surface is enabled', async () => {
		const marimoCommand = (calls: ReturnType<typeof makeFakeSandbox>['calls']) =>
			calls.startProcess.find(({ cmd }) => cmd.includes('marimo'))?.cmd ?? '';
		const plain = makeFakeSandbox();
		const plainRequest = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(plain.instance, multiPort),
		}).request;
		await expectOk<ApiSession>(await plainRequest('POST', sessionsPath()));
		expect(marimoCommand(plain.calls)).not.toContain('--watch');

		const watched = await createServices(bucket).notebooks.createNotebook(
			pid,
			{ title: 'Watched', description: 'd', code: 'import marimo as mo' },
			ACTOR,
		);
		const surfaced = makeFakeSandbox();
		const surfacedRequest = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(surfaced.instance, multiPort),
			deps: { sandbox: sandboxConfig({ surfaces: { opencode: opencodeSurfaceConfig() } }) },
		}).request;
		await expectOk<ApiSession>(
			await surfacedRequest('POST', `/projects/${pid}/notebooks/${watched.id}/sessions`),
		);
		expect(marimoCommand(surfaced.calls)).toContain('--watch');
	});

	it('rejects disabled and duplicate requested surfaces without provisioning', async () => {
		await expectError(
			await owner('POST', sessionsPath(), { surfaces: ['vscode'] }),
			409,
			'SURFACE_NOT_ENABLED',
		);
		await expectError(
			await owner('POST', sessionsPath(), { surfaces: ['vscode', 'vscode'] }),
			422,
			'VALIDATION_ERROR',
		);
		expect(await createServices(bucket).sessions.listSessions(nid)).toHaveLength(0);
	});

	it('rejects unknown surfaces and surfaces on app sessions before provisioning', async () => {
		await expectError(
			await owner('POST', sessionsPath(), { surfaces: ['terminal'] }),
			422,
			'VALIDATION_ERROR',
		);
		await expectError(
			await owner('POST', sessionsPath(), { mode: 'app', surfaces: ['opencode'] }),
			400,
			'BAD_REQUEST',
		);
		expect(await createServices(bucket).sessions.listSessions(nid)).toHaveLength(0);
	});

	it.each(['GET', 'POST', 'DELETE'] as const)(
		'rejects a %s surface request when the session belongs to another notebook',
		async (method) => {
			const services = createServices(bucket);
			const other = await services.notebooks.createNotebook(
				pid,
				{ title: 'Other', description: 'd', code: 'import marimo as mo' },
				ACTOR,
			);
			const session = await expectOk<ApiSession>(await owner('POST', sessionsPath()));
			const wrongPath = `/projects/${pid}/notebooks/${other.id}/sessions/${session.session_id}/surfaces/vscode`;

			await expectError(await owner(method, wrongPath), 404, 'NOT_FOUND');
		},
	);

	it('rejects OpenCode proxy exposure before starting the process', async () => {
		const { instance, calls } = makeFakeSandbox();
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(instance, multiPort),
			deps: {
				sandbox: sandboxConfig({
					appBaseUrl: 'https://hub.example',
					exposure: new ProxyExposure('test-signing-secret'),
					surfaces: {
						opencode: opencodeSurfaceConfig(),
					},
				}),
			},
		}).request;
		const session = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		const processCount = calls.startProcess.length;

		await expectError(
			await request('POST', sessionsPath(`/${session.session_id}/surfaces/opencode`)),
			409,
			'SURFACE_UNAVAILABLE',
		);
		expect(calls.startProcess).toHaveLength(processCount);
		expect(
			(await createServices(bucket).sessions.getSession(pid, session.session_id)).surfaces
				?.opencode,
		).toBeUndefined();
	});

	it('starts requested OpenCode with managed AI and rejects its open path', async () => {
		const { instance, calls } = makeFakeSandbox();
		const compute = fakeComputeFrom(instance, multiPort);
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute,
			deps: {
				ai: {
					upstreamBaseUrl: 'https://provider.example/v1',
					upstreamApiKey: 'real-upstream-key',
					model: 'gpt-test',
					signingSecret: 'test-signing-secret',
				},
				sandbox: sandboxConfig({
					surfaces: {
						opencode: opencodeSurfaceConfig(),
					},
				}),
			},
		}).request;

		const session = await expectOk<ApiSession>(
			await request('POST', sessionsPath(), { surfaces: ['opencode'] }),
		);
		await vi.waitFor(async () => {
			expect(
				(await createServices(bucket).sessions.getSession(pid, session.session_id)).surfaces
					?.opencode?.status,
			).toBe('ready');
		});
		expect(calls.exposePort.at(-1)?.port).toBe(4096);
		expect(calls.startProcess.at(-1)?.cmd).toContain("'opencode' 'web'");
		expect(calls.startProcess.at(-1)?.cmd).toContain(
			`'OPENCODE_CONFIG=/tmp/.marimohub/surfaces/${session.session_id}/opencode/config/opencode/opencode.json'`,
		);
		expect(calls.startProcess.at(-1)?.options?.env).toBeUndefined();
		const configWrite = calls.writeFile.find((file) =>
			file.path.endsWith('/config/opencode/opencode.json'),
		);
		const config = JSON.parse(String(configWrite?.content));
		expect(config).toMatchObject({
			model: 'marimohub/gpt-test',
			small_model: 'marimohub/gpt-test',
			provider: {
				marimohub: {
					options: {
						baseURL: 'http://localhost/api/ai/v1',
						apiKey: expect.any(String),
					},
				},
			},
		});
		expect(JSON.stringify(config)).not.toContain('real-upstream-key');

		const processCount = calls.startProcess.length;
		await expectError(
			await request('POST', sessionsPath(`/${session.session_id}/surfaces/opencode`), {
				open: 'notebook.py',
			}),
			400,
			'SURFACE_OPEN_INVALID',
		);
		expect(calls.startProcess).toHaveLength(processCount);
	});

	it('sanitizes an OpenCode preparation failure and leaves marimo running', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const { instance, calls } = makeFakeSandbox();
			const writeFiles = instance.writeFiles.bind(instance);
			instance.writeFiles = async (files) => {
				if (files.some((file) => file.path.endsWith('/config/opencode/opencode.json'))) {
					throw new Error('private sandbox path and credential details');
				}
				return writeFiles(files);
			};
			const request = createTestApi({
				bucket,
				userId: ACTOR,
				compute: fakeComputeFrom(instance, multiPort),
				deps: {
					sandbox: sandboxConfig({
						surfaces: {
							opencode: opencodeSurfaceConfig(),
						},
					}),
				},
			}).request;

			const session = await expectOk<ApiSession>(
				await request('POST', sessionsPath(), { surfaces: ['opencode'] }),
			);
			await vi.waitFor(async () => {
				const stored = await createServices(bucket).sessions.getSession(pid, session.session_id);
				expect(stored.status).toBe('running');
				expect(stored.surfaces?.opencode).toEqual({
					status: 'failed',
					last_error: 'Failed to start opencode (Error)',
				});
			});
			expect(calls.startProcess.some(({ cmd }) => cmd.includes("'opencode' 'web'"))).toBe(false);
			expect(JSON.stringify(log.mock.calls)).not.toContain('private sandbox path');
		} finally {
			log.mockRestore();
		}
	});

	it('starts requested surfaces concurrently and isolates an unavailable OpenCode binary', async () => {
		const { instance, calls } = makeFakeSandbox();
		const originalExec = instance.exec.bind(instance);
		instance.exec = async (cmd, options) =>
			cmd.includes('command -v opencode')
				? {
						success: false,
						stdout: '',
						stderr: 'not found',
						error: { code: 'COMMAND_FAILED' },
					}
				: originalExec(cmd, options);
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute: fakeComputeFrom(instance, multiPort),
			deps: {
				sandbox: sandboxConfig({
					surfaces: {
						vscode: vscodeSurfaceConfig(),
						opencode: opencodeSurfaceConfig(),
					},
				}),
			},
		}).request;

		const session = await expectOk<ApiSession>(
			await request('POST', sessionsPath(), { surfaces: ['vscode', 'opencode'] }),
		);
		await vi.waitFor(async () => {
			const stored = await createServices(bucket).sessions.getSession(pid, session.session_id);
			expect(stored.surfaces?.vscode?.status).toBe('ready');
			expect(stored.surfaces?.opencode).toMatchObject({
				status: 'unavailable',
				last_error: 'The sandbox image does not include opencode',
			});
		});
		expect(calls.startProcess.some(({ cmd }) => cmd.includes('code-server'))).toBe(true);
		expect(calls.startProcess.some(({ cmd }) => cmd.includes("'opencode' 'web'"))).toBe(false);
	});

	it('rejects an unsafe VS Code open path without starting the surface', async () => {
		const { instance, calls } = makeFakeSandbox();
		const compute = fakeComputeFrom(instance, multiPort);
		const request = createTestApi({
			bucket,
			userId: ACTOR,
			compute,
			deps: {
				sandbox: sandboxConfig({
					surfaces: {
						vscode: vscodeSurfaceConfig(),
					},
				}),
			},
		}).request;
		const session = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		const processCount = calls.startProcess.length;

		await expectError(
			await request('POST', sessionsPath(`/${session.session_id}/surfaces/vscode`), {
				open: '../secret.py',
			}),
			400,
			'SURFACE_OPEN_INVALID',
		);
		expect(calls.startProcess).toHaveLength(processCount);
		expect(
			(await createServices(bucket).sessions.getSession(pid, session.session_id)).surfaces?.vscode,
		).toBeUndefined();
	});

	it('does not eagerly start secondary surfaces for a viewer-owned ephemeral session', async () => {
		const { instance, calls } = makeFakeSandbox();
		const compute = fakeComputeFrom(instance, multiPort);
		const request = createTestApi({
			bucket,
			userId: STRANGER,
			compute,
			deps: {
				sandbox: sandboxConfig({
					surfaces: {
						vscode: vscodeSurfaceConfig({ start: 'eager' }),
						opencode: opencodeSurfaceConfig({ start: 'eager' }),
					},
				}),
				policy: { defaultRole: 'viewer', viewerMode: 'ephemeral-sandbox' },
			},
		}).request;

		const session = await expectOk<ApiSession>(await request('POST', sessionsPath()));
		expect(session.ephemeral).toBe(true);
		expect(session.can.surfaces?.vscode).toBe(false);
		expect(session.can.surfaces?.opencode).toBe(false);
		expect(calls.startProcess.some(({ cmd }) => cmd.includes('code-server'))).toBe(false);
		expect(calls.startProcess.some(({ cmd }) => cmd.includes('opencode'))).toBe(false);
		expect(
			(await createServices(bucket).sessions.getSession(pid, session.session_id)).surfaces?.vscode,
		).toBeUndefined();
		expect(
			(await createServices(bucket).sessions.getSession(pid, session.session_id)).surfaces
				?.opencode,
		).toBeUndefined();
		await expectError(
			await request('POST', sessionsPath(`/${session.session_id}/surfaces/vscode`)),
			403,
			'SURFACE_FORBIDDEN',
		);
		await expectError(
			await request('POST', sessionsPath(`/${session.session_id}/surfaces/opencode`)),
			403,
			'SURFACE_FORBIDDEN',
		);
	});

	it('keeps session creation successful when configured eager startup is unsupported', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const request = createTestApi({
				bucket,
				userId: ACTOR,
				compute: makeFakeCompute(),
				deps: {
					sandbox: sandboxConfig({
						surfaces: {
							vscode: vscodeSurfaceConfig({ start: 'eager' }),
						},
					}),
				},
			}).request;

			const session = await expectOk<ApiSession>(await request('POST', sessionsPath()));

			expect(session.status).toBe('running');
			expect(session.surfaces?.vscode).toBeUndefined();
			expect(log.mock.calls.some(([line]) => String(line).includes('surface_start_failed'))).toBe(
				true,
			);
		} finally {
			log.mockRestore();
		}
	});
});
