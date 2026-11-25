import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServices, SandboxId } from '@marimo-hub/core';
import type {
	ExecResult,
	JobRun,
	NotebookId,
	ProjectId,
	SandboxProvider,
	UserId,
} from '@marimo-hub/core';
import { ACTOR, makeFakeSandbox, uid } from '@marimo-hub/core/testing';
import type { MemoryBucket } from '@marimo-hub/core/testing';
import { DEFAULT_JOBS_CONFIG } from '../context';
import { createInitializedBucket, createTestApi, expectError, expectOk } from '../testing';
import { RUN_FOLLOW_PATH } from './follow';

const VIEWER = uid('viewer-1');
const EDITOR = uid('editor-1');
const WORKDIR = '/workspace';
const SANDBOX = SandboxId.parse('sb-0123456789abcdef');
const SHELL =
	'<script>{"runtimeConfig": [{"url": "https://marimohub-follow.invalid/runtime", "authToken": "marimohub-follow-token"}]}</script>';

describe('following a live run', () => {
	let bucket: MemoryBucket;
	let services: ReturnType<typeof createServices>;
	let pid: ProjectId;
	let nid: NotebookId;
	let jid: string;
	/** Replies the in-sandbox follow client gives, in order; the last one repeats. */
	let batches: string[];
	let cursors: string[];
	let attached: unknown[];
	let compute: SandboxProvider;
	/** Overrides the in-sandbox follow client for one test. */
	let exec: ((command: string) => Promise<ExecResult>) | undefined;
	/** With a faked clock, the relay's own sleeps move it forward; the 15 s ping does not. */
	let sleepsAdvanceClock: boolean;

	const api = (userId: UserId = ACTOR, liveRuns = true) =>
		createTestApi({
			bucket,
			userId,
			compute,
			deps: {
				jobs: {
					...DEFAULT_JOBS_CONFIG,
					liveRuns: liveRuns ? { signingSecret: 'secret' } : undefined,
				},
				sandbox: { appBaseUrl: 'https://hub.example/' } as never,
				sleep: async (ms, signal) => {
					signal?.throwIfAborted();
					if (sleepsAdvanceClock && ms !== 15_000) vi.setSystemTime(Date.now() + ms);
					await new Promise((resolve) => setTimeout(resolve, 1));
					signal?.throwIfAborted();
				},
			},
		});

	beforeEach(async () => {
		bucket = await createInitializedBucket();
		services = createServices(bucket);
		batches = ['{"gone": true}'];
		cursors = [];
		attached = [];
		const { instance } = makeFakeSandbox({
			files: { [`${WORKDIR}/__marimo__/.job_follow.html`]: SHELL },
		});
		exec = undefined;
		sleepsAdvanceClock = false;
		instance.exec = async (command) => {
			cursors.push(/ '([^']*)'$/.exec(command)?.[1] ?? '?');
			if (exec) return exec(command);
			const stdout = batches.length > 1 ? batches.shift()! : batches[0];
			return { success: true, stdout, stderr: '' };
		};
		compute = {
			create: () => {
				throw new Error('following must not create a sandbox');
			},
			connectExisting: (id, options) => {
				attached.push([id, options]);
				return instance;
			},
			proxy: async () => null,
		};
		const project = await services.projects.createProject({ name: 'p', description: '' }, ACTOR);
		pid = project.id;
		await services.projects.addMember(pid, { user_id: VIEWER }, 'viewer', ACTOR);
		await services.projects.addMember(pid, { user_id: EDITOR }, 'editor', ACTOR);
		const notebook = await services.notebooks.createNotebook(
			pid,
			{ title: 'nb', description: '', code: 'import marimo' },
			ACTOR,
		);
		nid = notebook.id;
		const job = await services.jobs.createJob(pid, nid, { name: 'nightly' }, ACTOR);
		jid = job.id;
	});

	async function liveRun(
		live = true,
		options: { deadlineMs?: number; reconnectReference?: string | null } = {},
	): Promise<JobRun> {
		const job = await services.jobs.getJob(pid, nid, jid as never);
		const queued = await services.jobRuns.enqueue({
			job,
			trigger: 'manual',
			triggeredBy: ACTOR,
			timeoutSeconds: 900,
		});
		const provisioned = await services.jobRuns.transition(queued, 'provision', () => ({
			sandbox_id: SANDBOX,
			deadline_at: new Date(Date.now() + (options.deadlineMs ?? 900_000)).toISOString(),
		}));
		const reference = options.reconnectReference === null ? {} : { reconnect_reference: 'ref-1' };
		return (
			await services.jobRuns.transition(provisioned.run, 'start', () =>
				live ? { live: { workdir: WORKDIR }, ...reference } : {},
			)
		).run;
	}

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const events = (...items: { event: string; id?: string; data: string }[]) =>
		JSON.stringify({ events: items });
	const until = async (condition: () => boolean) => {
		while (!condition()) await new Promise((resolve) => setTimeout(resolve, 1));
	};
	const body = (response: Response) => response.text();

	const followPath = (run: JobRun) =>
		`/projects/${pid}/notebooks/${nid}/jobs/${jid}/runs/${run.run_id}/follow`;

	async function view(run: JobRun, who = api()) {
		const data = await expectOk<{ html: string; expires_at: string }>(
			await who.request('POST', followPath(run)),
		);
		const token = /"authToken": "([^"]+)"/.exec(data.html)?.[1];
		expect(token).toMatch(/^mhub_follow_/);
		return { ...data, token: token! };
	}

	const stream = (app: ReturnType<typeof api>['app'], token: string, headers = {}) =>
		app.request(`${RUN_FOLLOW_PATH}/sse?session_id=s1`, {
			headers: { Authorization: `Bearer ${token}`, ...headers },
		});

	it('marks a live run and binds its view to this deployment and a private token', async () => {
		const run = await liveRun();
		const who = api();

		expect(
			(await expectOk<any>(await who.request('GET', followPath(run).replace('/follow', '')))).live,
		).toBe(true);
		const { html, expires_at, token } = await view(run, who);

		expect(html).toContain('"url": "https://hub.example/api/run-follow/v1"');
		expect(html).not.toContain('marimohub-follow');
		expect(Date.parse(expires_at)).toBeLessThanOrEqual(Date.parse(run.deadline_at!));
		expect(Date.parse(expires_at)).toBeGreaterThan(Date.now());
		expect(attached).toEqual([[SANDBOX, { reconnectReference: 'ref-1' }]]);
		// The frame runs notebook-authored scripts; the token must not reveal who is watching.
		expect(
			Buffer.from(token.slice('mhub_follow_'.length), 'base64url').toString('latin1'),
		).not.toContain(ACTOR);
	});

	it('offers the view to editors and the triggering user only', async () => {
		const run = await liveRun();

		await expectOk(await api(EDITOR).request('POST', followPath(run)));
		await expectError(await api(VIEWER).request('POST', followPath(run)), 404);
	});

	it.each([
		['the run does not execute under a marimo host', async () => liveRun(false), true],
		['live runs are off', async () => liveRun(), false],
	] as const)('answers RUN_NOT_FOLLOWABLE when %s', async (_name, make, liveRuns) => {
		const run = await make();

		await expectError(
			await api(ACTOR, liveRuns).request('POST', followPath(run)),
			409,
			'RUN_NOT_FOLLOWABLE',
		);

		expect(attached).toEqual([]);
	});

	it('answers RUN_NOT_FOLLOWABLE for a finished run and before the host serves a view', async () => {
		const run = await liveRun();
		const { instance } = makeFakeSandbox();
		compute = { ...compute, connectExisting: () => instance };
		await expectError(await api().request('POST', followPath(run)), 409, 'RUN_NOT_FOLLOWABLE');

		const finished = await services.jobRuns.transition(run, 'succeed');
		await expectError(
			await api().request('POST', followPath(finished.run)),
			409,
			'RUN_NOT_FOLLOWABLE',
		);
	});

	it('relays the stream read-only, resumes from the last cursor, and ends with the run', async () => {
		const run = await liveRun();
		const who = api();
		const { token } = await view(run, who);
		batches = [
			JSON.stringify({
				events: [
					{
						event: 'notebook',
						data: '{"notebook":{"id":"nb-1","operations":["runtime.run","notebook.edit"]}}',
					},
					{ event: 'ready', id: 'e:1', data: '{}' },
				],
			}),
			JSON.stringify({
				events: [{ event: 'output', id: 'e:2', data: '{"output":{"value":NaN}}' }],
			}),
			'{"gone": true}',
		];
		const finishing = (async () => {
			while (batches.length > 1) await new Promise((resolve) => setTimeout(resolve, 1));
			await services.jobRuns.transition(run, 'succeed');
		})();

		const response = await stream(who.app, token);
		const text = await response.text();
		await finishing;

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/event-stream');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(text).toBe(
			'event: notebook\ndata: {"notebook":{"id":"nb-1","operations":[]}}\n\n' +
				'id: e:1\nevent: ready\ndata: {}\n\n' +
				'id: e:2\nevent: output\ndata: {"output":{"value":NaN}}\n\n',
		);
		expect(cursors.slice(0, 3)).toEqual(['', 'e:1', 'e:2']);
	});

	it('resumes a reconnecting follower from its Last-Event-ID', async () => {
		const run = await liveRun();
		const who = api();
		const { token } = await view(run, who);
		await services.jobRuns.transition(run, 'succeed');
		const live = await liveRun();
		const second = await view(live, who);
		batches = ['{"gone": true}'];
		const ending = (async () => {
			while (cursors.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
			await services.jobRuns.transition(live, 'succeed');
		})();

		// The token of the finished run no longer opens a stream.
		expect((await stream(who.app, token)).status).toBe(409);
		await (await stream(who.app, second.token, { 'Last-Event-ID': 'e:41' })).text();
		await ending;

		expect(cursors[0]).toBe('e:41');
	});

	it('rejects a missing, forged, or foreign-deployment token', async () => {
		const run = await liveRun();
		const who = api();
		const { token } = await view(run, who);

		expect((await who.app.request(`${RUN_FOLLOW_PATH}/sse`)).status).toBe(401);
		expect((await stream(who.app, `${token}x`)).status).toBe(401);
		expect((await stream(api(ACTOR, false).app, token)).status).toBe(401);
		expect(cursors).toEqual([]);
	});

	it('stops serving a follower who lost access or was suspended', async () => {
		const run = await liveRun();
		const editor = api(EDITOR);
		const { token } = await view(run, editor);

		await services.projects.removeMember(pid, EDITOR, ACTOR);
		expect((await stream(editor.app, token)).status).toBe(404);

		const owner = api();
		const mine = await view(run, owner);
		await owner.deps.services.identities.setSuspension(ACTOR, true);
		expect((await stream(owner.app, mine.token)).status).toBe(404);
		expect(cursors).toEqual([]);
	});

	it('serves the frontend liveness probe and preflight without credentials', async () => {
		const { app } = api();

		const health = await app.request(`${RUN_FOLLOW_PATH}/health`);
		expect(health.status).toBe(200);
		expect(health.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(await health.json()).toEqual({ status: 'healthy' });

		const preflight = await app.request(`${RUN_FOLLOW_PATH}/sse`, {
			method: 'OPTIONS',
			headers: { 'Access-Control-Request-Headers': 'authorization,marimo-session-id' },
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe(
			'authorization,marimo-session-id',
		);
	});

	it('answers every other marimo route as unsupported', async () => {
		const { app } = api();

		const response = await app.request(`${RUN_FOLLOW_PATH}/api/kernel/function_call`, {
			method: 'POST',
			body: '{}',
		});

		expect(response.status).toBe(501);
		expect(response.headers.get('Content-Type')).toBe('application/problem+json');
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(await response.json()).toMatchObject({
			type: 'urn:marimo:problem:unsupported-operation',
		});
	});
	describe('unhappy paths', () => {
		it('refuses a view of a run that is past its deadline', async () => {
			const run = await liveRun(true, { deadlineMs: -1_000 });

			await expectError(await api().request('POST', followPath(run)), 409, 'RUN_NOT_FOLLOWABLE');
		});

		it('follows a run whose provider gave no reconnect reference', async () => {
			const run = await liveRun(true, { reconnectReference: null });

			await view(run);

			expect(attached).toEqual([[SANDBOX, { reconnectReference: undefined }]]);
		});

		it('answers 503 when the view cannot be read from the sandbox', async () => {
			const run = await liveRun();
			const { instance } = makeFakeSandbox({
				files: { [`${WORKDIR}/__marimo__/.job_follow.html`]: '<html>no placeholders</html>' },
			});
			compute = { ...compute, connectExisting: () => instance };

			await expectError(await api().request('POST', followPath(run)), 503, 'SERVICE_UNAVAILABLE');
		});

		it('stops serving a follower who was demoted to viewer', async () => {
			const run = await liveRun();
			const editor = api(EDITOR);
			const { token } = await view(run, editor);

			await services.projects.updateMemberRole(pid, EDITOR, 'viewer', ACTOR);

			expect((await stream(editor.app, token)).status).toBe(404);
			expect(cursors).toEqual([]);
		});

		it('ends an open stream when the follower loses access', async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			sleepsAdvanceClock = true;
			const run = await liveRun();
			const editor = api(EDITOR);
			const { token } = await view(run, editor);
			batches = [events({ event: 'ready', id: 'e:1', data: '{}' })];

			const response = await stream(editor.app, token);
			await until(() => cursors.length >= 2);
			await services.projects.removeMember(pid, EDITOR, ACTOR);
			const polled = cursors.length;

			expect(await body(response)).toContain('event: ready');
			// The recheck runs every 10 s of relay time, at 250 ms per batch.
			expect(cursors.length - polled).toBeLessThanOrEqual(45);
		});

		it('ends an open stream when its token expires', async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			sleepsAdvanceClock = true;
			// The token expires with the run's deadline, 20 s of relay time away.
			const run = await liveRun(true, { deadlineMs: 20_000 });
			const who = api();
			const { token, expires_at } = await view(run, who);
			batches = [events({ event: 'ready', id: 'e:1', data: '{}' })];

			await body(await stream(who.app, token));

			expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(expires_at));
			expect((await stream(who.app, token)).status).toBe(401);
		});

		it('ends quietly when the sandbox is gone because the run finished', async () => {
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			const run = await liveRun();
			const who = api();
			const { token } = await view(run, who);
			exec = async () => {
				await services.jobRuns.transition(run, 'succeed');
				throw new Error('sandbox not found');
			};

			const response = await stream(who.app, token);

			expect(response.status).toBe(200);
			expect(await body(response)).toBe('');
			expect(log).not.toHaveBeenCalled();
		});

		it('ends and reports an unexpected read failure while the run is still live', async () => {
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			const run = await liveRun();
			const who = api();
			const { token } = await view(run, who);
			exec = async () => {
				throw new Error('exec transport failed');
			};

			expect(await body(await stream(who.app, token))).toBe('');

			expect(
				log.mock.calls.filter((call) => String(call[0]).includes('run_follow_stream_failed')),
			).toHaveLength(1);
		});

		it('ends without a report when the follow client cannot read the host', async () => {
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			const run = await liveRun();
			const who = api();
			const { token } = await view(run, who);
			exec = async () => ({ success: true, stdout: '{"error": true}', stderr: '' });

			expect(await body(await stream(who.app, token))).toBe('');

			expect(log).not.toHaveBeenCalled();
			expect(cursors).toHaveLength(1);
		});

		it('ends after the grace period when the host never serves', async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			sleepsAdvanceClock = true;
			const run = await liveRun();
			const who = api();
			const { token } = await view(run, who);
			batches = ['{"gone": true}'];

			expect(await body(await stream(who.app, token))).toBe('');

			// One probe per second for the 30 s grace period.
			expect(cursors.length).toBeGreaterThanOrEqual(25);
			expect(cursors.length).toBeLessThanOrEqual(35);
		});

		it('drops a malformed notebook record and keeps relaying', async () => {
			const run = await liveRun();
			const who = api();
			const { token } = await view(run, who);
			batches = [
				events(
					{ event: 'notebook', data: 'not json' },
					{ event: 'notebook', data: '{"notebook":"x"}' },
					{ event: 'notebook', data: 'null' },
					{ event: 'out\nput', id: 'e:1\r\nevent: close', data: 'line one\nline\rtwo' },
				),
				'{"gone": true}',
			];
			const finishing = until(() => batches.length === 1).then(() =>
				services.jobRuns.transition(run, 'succeed'),
			);

			const text = await body(await stream(who.app, token));
			await finishing;

			expect(text).toBe('id: e:1event: close\nevent: output\ndata: line one\ndata: linetwo\n\n');
		});

		it('limits concurrent followers of one run and frees a slot when one disconnects', async () => {
			const run = await liveRun();
			const who = api();
			const { token } = await view(run, who);
			batches = [events({ event: 'ready', id: 'e:1', data: '{}' })];
			const open = (signal?: AbortSignal) =>
				who.app.request(`${RUN_FOLLOW_PATH}/sse`, {
					headers: { Authorization: `Bearer ${token}` },
					signal,
				});
			const first = new AbortController();
			const streams = [await open(first.signal)];
			for (let i = 1; i < 8; i++) streams.push(await open());

			expect(streams.map((response) => response.status)).toEqual(Array(8).fill(200));
			await expectError(await open(), 429, 'RESOURCE_EXHAUSTED');

			first.abort();
			await streams[0].body?.cancel().catch(() => {});
			let reopened = await open();
			for (let i = 0; i < 200 && reopened.status === 429; i++) {
				await new Promise((resolve) => setTimeout(resolve, 5));
				reopened = await open();
			}
			expect(reopened.status).toBe(200);

			await services.jobRuns.transition(run, 'succeed');
			exec = async () => ({ success: true, stdout: '{"gone": true}', stderr: '' });
			await Promise.all([...streams.slice(1), reopened].map((response) => response.text()));
			expect((await open()).status).toBe(409);
		});

		it('does not serve the follow endpoint from a deployment without jobs', async () => {
			const run = await liveRun();
			const { token } = await view(run);
			const off = createTestApi({ bucket, compute, deps: { jobs: undefined } });

			expect((await stream(off.app, token)).status).toBe(401);
			await expectError(await off.request('POST', followPath(run)), 404);
		});
	});
});
