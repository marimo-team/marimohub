/**
 * boxd compute backend: a `SandboxProvider` backed by boxd machines (boxd.sh).
 *
 * Each sandbox is one isolated machine, labelled with our SandboxId and owner tag
 * so a restarted hub can find it again. Machines usually start from a snapshot
 * with marimo + uv pre-installed (see `examples/boxd-template`). The kernel port is
 * served on the machine's default HTTPS route (`https://<machine>.boxd.sh`); other
 * ports get a named route (`https://p<port>.<machine>.boxd.sh`).
 *
 * The `@boxd-sh/sdk` package is an OPTIONAL, bring-your-own dependency, like the
 * `e2b` SDK for the E2B backend. The adapter is written against the narrow
 * {@link BoxdClient} seam below; tests inject a fake, and production lazily
 * `import()`s the SDK via {@link createBoxdClient}.
 */
import {
	base64Encode,
	readBoundedFile,
	buildFindFilesCommand,
	buildGitCloneCommand,
	buildLaunchCommand,
	classifyListFilesFailure,
	collectBoundedOutput,
	errorMessage,
	LAUNCH_MARKER_GRACE_MS,
	launchOutcomeResult,
	launchTimeoutResult,
	mapWithConcurrency,
	parseLaunchOutput,
	parseFindFilesOutput,
	pollUntilReady,
	setupCompleteMarker,
	shellQuote,
	transportFailureResult,
	validateOutputBudget,
	withEnvPrefix,
	WRITE_CONCURRENCY,
} from '@marimo-hub/compute-commons';
import { SandboxId } from '@marimo-hub/core/ids';
import { NotFoundError } from '@marimo-hub/core/errors';
import { sleep } from '@marimo-hub/core/duration';
import type {
	BoundedReadOptions,
	ActiveSandbox,
	CreateSandboxOptions,
	ExecOptions,
	ExecResult,
	ExecStreamOptions,
	ExposePortOptions,
	ExposePortResult,
	GitCheckoutOptions,
	LaunchProcessOptions,
	ListFilesOptions,
	ListFilesResult,
	MountBucketOptions,
	ReadFileResult,
	SandboxFileWrite,
	SandboxInstance,
	SandboxProcess,
	SandboxLaunchResult,
	SandboxProvider,
	SetEnvVarsOptions,
	StartProcessOptions,
	WaitForPortOptions,
} from '@marimo-hub/core/ports/sandbox';
import { execResult, listFilesFailure, readFileFailure } from '@marimo-hub/core/ports/sandbox';

const ID_LABEL = 'mh-sandbox-id';
const OWNER_LABEL = 'mh-owner';
const DEFAULT_OWNER_TAG = 'marimohub';
const DEFAULT_NAME_PREFIX = 'marimohub-';
const DEFAULT_WORKDIR = '/workspace';
/** marimo's kernel port (matches SandboxProvisioner's MARIMO_PORT). */
const KERNEL_PORT = 2718;
const LAUNCH_POLL_INTERVAL_MS = 50;
const PROBE_TIMEOUT_MS = 5_000;
/** Machines in these states are gone for good; a strict reconnect must not revive them. */
const GONE_STATUSES = new Set(['stopped', 'failed', 'destroyed']);
/** Machines in these states exist but do not accept commands yet. */
const STARTING_STATUSES = new Set(['pending', 'starting', 'migrating']);

function definedEnv(env?: Record<string, string | undefined>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

// --- Injection seam: the slice of the boxd SDK this adapter uses -------------

export interface BoxdMachineInfo {
	id: string;
	name: string;
	status: string;
	createdAt?: string;
	labels: Record<string, string>;
}

export interface BoxdExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface BoxdExecStream {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	wait(): Promise<number>;
	close(): void;
}

export interface BoxdClient {
	/** Create a machine and wait until it accepts commands. */
	create(options: {
		name: string;
		labels: Record<string, string>;
		snapshot?: string;
		deleteAfterSeconds?: number;
	}): Promise<BoxdMachineInfo>;
	/** Wait until a machine that is still starting accepts commands. */
	waitUntilReady(id: string): Promise<BoxdMachineInfo>;
	/** Machines carrying every given label. */
	list(labels: Record<string, string>): Promise<BoxdMachineInfo[]>;
	/** Start a stopped machine and wait until it accepts commands. */
	start(id: string): Promise<BoxdMachineInfo>;
	exec(id: string, argv: string[], options?: { timeoutMs?: number }): Promise<BoxdExecResult>;
	execStream(id: string, argv: string[]): BoxdExecStream;
	upload(id: string, path: string, content: string | Uint8Array): Promise<void>;
	download(id: string, path: string): Promise<Uint8Array>;
	/** Route public HTTPS to `port`; `name` selects a named route, else the default one. */
	route(id: string, port: number, name?: string): Promise<string>;
	delete(id: string): Promise<void>;
}

// --- Config -----------------------------------------------------------------

export interface BoxdConfig {
	/** boxd API key (`BOXD_API_KEY`). */
	apiKey: string;
	/** Org the machines are created in. */
	org?: string;
	/** Region (`fra`, `nyc`, ...). Defaults to the SDK's region. */
	region?: string;
	/** Snapshot with marimo + uv + python to boot each machine from. */
	snapshot?: string;
	/** Label stamped on every machine we own (discovery and cleanup). Default `marimohub`. */
	ownerTag?: string;
	/** Machine name prefix; the SandboxId follows it. Default `marimohub-`. */
	namePrefix?: string;
	/** Extra labels for every machine (cost tracking, filtering). */
	labels?: Record<string, string>;
	/** Directory the hub writes notebooks into; created and owned by the exec user. Default `/workspace`. */
	workdir?: string;
	/** Hard cap on machine lifetime; boxd deletes the machine past it. */
	maxLifetimeSeconds?: number;
}

interface BoxdSandboxState {
	machinePromise?: Promise<BoxdMachineInfo>;
	destroyPromise?: Promise<void>;
	destroyGeneration?: number;
}

interface BoxdSandboxStateEntry {
	ref: WeakRef<BoxdSandboxState>;
	retained?: BoxdSandboxState;
	retainCount: number;
}

function routeName(port: number): string | undefined {
	return port === KERNEL_PORT ? undefined : `p${port}`;
}

function sh(cmd: string): string[] {
	// A login shell, so a snapshot's /etc/profile.d env (UV_PROJECT_ENVIRONMENT) applies.
	return ['sh', '-lc', cmd];
}

class BoxdSandboxInstance implements SandboxInstance {
	readonly supportsBucketMount = false;
	private env: Record<string, string> = {};
	private envDefaults: Record<string, string> = {};
	private readonly attachmentState: BoxdSandboxState = {};
	private attachmentGeneration = 0;
	private processSeq = 0;

	constructor(
		private readonly id: SandboxId,
		private readonly config: BoxdConfig,
		private readonly client: BoxdClient,
		private readonly state: BoxdSandboxState,
		private readonly retainState: () => () => void,
		private readonly existingOnly = false,
	) {}

	private get ownLabels(): Record<string, string> {
		return { [ID_LABEL]: this.id, [OWNER_LABEL]: this.config.ownerTag ?? DEFAULT_OWNER_TAG };
	}

	private owned(): Promise<BoxdMachineInfo[]> {
		return this.client.list(this.ownLabels);
	}

	/** Resolve the machine for our id: cached → reconnect by label → create. */
	private ensure(): Promise<BoxdMachineInfo> {
		const destroyPromise = this.state.destroyPromise;
		if (destroyPromise) return destroyPromise.then(() => this.ensure());
		if (this.attachmentGeneration !== (this.state.destroyGeneration ?? 0)) {
			this.attachmentState.machinePromise = undefined;
			this.attachmentGeneration = this.state.destroyGeneration ?? 0;
		}
		const state = this.existingOnly ? this.attachmentState : this.state;
		if (state.machinePromise) return state.machinePromise;
		const promise = (async () => {
			const existing = await this.owned();
			const live = existing.find((m) => !GONE_STATUSES.has(m.status));
			if (live) return this.whenReady(live);
			if (this.existingOnly) throw new NotFoundError(`Sandbox ${this.id} is no longer available`);
			const stopped = existing.find((m) => m.status === 'stopped');
			if (stopped) return this.client.start(stopped.id);
			// A failed machine can never serve the session, and it holds the machine name.
			for (const failed of existing.filter((m) => m.status === 'failed')) {
				await this.client.delete(failed.id);
			}
			let created: BoxdMachineInfo;
			try {
				created = await this.client.create({
					name: `${this.config.namePrefix ?? DEFAULT_NAME_PREFIX}${this.id}`,
					labels: { ...this.config.labels, ...this.ownLabels },
					snapshot: this.config.snapshot,
					deleteAfterSeconds: this.config.maxLifetimeSeconds,
				});
			} catch (error) {
				// Another hub replica may have created this sandbox's machine first.
				const winner = (await this.owned()).find((m) => !GONE_STATUSES.has(m.status));
				if (winner) return this.whenReady(winner);
				throw error;
			}
			try {
				await this.prepareWorkdir(created.id);
			} catch (error) {
				await this.client.delete(created.id).catch(() => {});
				throw error;
			}
			return created;
		})();
		state.machinePromise = promise;
		const releaseState = this.retainState();
		void promise.then(releaseState, () => {
			if (state.machinePromise === promise) state.machinePromise = undefined;
			releaseState();
		});
		return promise;
	}

	private whenReady(machine: BoxdMachineInfo): Promise<BoxdMachineInfo> | BoxdMachineInfo {
		return STARTING_STATUSES.has(machine.status) ? this.client.waitUntilReady(machine.id) : machine;
	}

	private async prepareWorkdir(machineId: string): Promise<void> {
		// The exec user is unprivileged; the workdir usually lives outside its home.
		const workdir = shellQuote(this.config.workdir ?? DEFAULT_WORKDIR);
		const prepared = await this.client.exec(machineId, [
			'sh',
			'-c',
			`sudo -n mkdir -p ${workdir} && sudo -n chown "$(id -u):$(id -g)" ${workdir}`,
		]);
		if (prepared.exitCode !== 0) {
			throw new Error(`boxd workdir setup failed: ${prepared.stderr || prepared.stdout}`);
		}
	}

	async ready(): Promise<void> {
		await this.ensure();
	}

	private withEnv(cmd: string, extra: Record<string, string> = {}): string {
		return withEnvPrefix(cmd, { ...this.env, ...extra }, this.envDefaults);
	}

	async exec(cmd: string, options?: ExecOptions): Promise<ExecResult> {
		const machine = await this.ensure();
		const argv = sh(this.withEnv(cmd));
		if (options?.maxOutputBytes === undefined) {
			const res = await this.client.exec(machine.id, argv, { timeoutMs: options?.timeout });
			return execResult(res.exitCode === 0, res.stdout, res.stderr);
		}
		validateOutputBudget(options.maxOutputBytes);
		const stream = this.client.execStream(machine.id, argv);
		try {
			const { stdout, stderr, result } = await collectBoundedOutput(
				{ stdout: stream.stdout, stderr: stream.stderr, wait: () => stream.wait() },
				{ maxOutputBytes: options.maxOutputBytes, timeout: options.timeout },
			);
			return execResult(result === 0, stdout, stderr);
		} finally {
			// Closing the stream ends the remote process group on overflow or deadline.
			stream.close();
		}
	}

	async execStream(cmd: string, options?: ExecStreamOptions): Promise<ReadableStream> {
		const machine = await this.ensure();
		const stream = this.client.execStream(machine.id, sh(this.withEnv(cmd)));
		void stream.stderr.cancel().catch(() => {});
		void stream.wait().catch(() => {});
		const timer =
			options?.timeout && options.timeout > 0
				? setTimeout(() => stream.close(), options.timeout)
				: undefined;
		const reader = stream.stdout.getReader();
		return new ReadableStream<Uint8Array>({
			async pull(controller) {
				const { done, value } = await reader.read();
				if (done) {
					if (timer !== undefined) clearTimeout(timer);
					controller.close();
				} else controller.enqueue(value);
			},
			cancel() {
				if (timer !== undefined) clearTimeout(timer);
				stream.close();
			},
		});
	}

	async readFileBounded(path: string, options: BoundedReadOptions): Promise<ReadFileResult> {
		return readBoundedFile(path, options, (command, limits) => this.exec(command, limits));
	}

	async readFile(path: string): Promise<ReadFileResult> {
		let bytes: Uint8Array;
		try {
			const machine = await this.ensure();
			bytes = await this.client.download(machine.id, path);
			// An empty download is also what a missing path returns; tell them apart.
			if (bytes.byteLength === 0) {
				const probe = await this.client.exec(machine.id, ['test', '-f', path]);
				if (probe.exitCode !== 0) return readFileFailure('NOT_FOUND');
			}
		} catch {
			return readFileFailure('READ_FAILED');
		}
		try {
			return {
				success: true,
				content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
				encoding: 'utf-8',
			};
		} catch {
			return { success: true, content: base64Encode(bytes), encoding: 'base64' };
		}
	}

	async listFiles(path: string, options?: ListFilesOptions): Promise<ListFilesResult> {
		const res = await this.exec(buildFindFilesCommand(path, options));
		if (!res.success) {
			return listFilesFailure(classifyListFilesFailure(res));
		}
		return { success: true, files: parseFindFilesOutput(res.stdout, path, options) };
	}

	async writeFiles(files: readonly SandboxFileWrite[]): Promise<void> {
		if (files.length === 0) return;
		const machine = await this.ensure();
		// Uploads stream the bytes and create parent directories, so nothing rides argv.
		await mapWithConcurrency(files, WRITE_CONCURRENCY, (f) =>
			this.client.upload(machine.id, f.path, f.content),
		);
	}

	async gitCheckout(repo: string, options?: GitCheckoutOptions): Promise<void> {
		const res = await this.exec(buildGitCloneCommand(repo, options));
		if (!res.success) throw new Error(`git checkout failed: ${res.stderr}`);
	}

	async setEnvVars(vars: Record<string, string>, options?: SetEnvVarsOptions): Promise<void> {
		if (options?.onlyIfUnset) {
			this.envDefaults = { ...this.envDefaults, ...vars };
		} else {
			this.env = { ...this.env, ...vars };
		}
	}

	async mountBucket(_options: MountBucketOptions): Promise<void> {
		// Throwing makes SandboxProvisioner fall back to copying notebook files in and out.
		throw new Error('boxd compute uses file copy, not bucket mount');
	}

	async unmountBucket(_mountPath: string): Promise<void> {}

	async startProcess(cmd: string, options?: StartProcessOptions): Promise<SandboxProcess> {
		const machine = await this.ensure();
		const seq = ++this.processSeq;
		const logPath = `/tmp/marimohub-${this.id}-${seq}.log`;
		const inner = this.withEnv(
			(options?.cwd ? `cd ${shellQuote(options.cwd)} && ` : '') + cmd,
			definedEnv(options?.env),
		);
		// setsid detaches the process group so it outlives this exec; $! is its leader.
		const launch =
			`setsid sh -lc ${shellQuote(`exec > ${logPath} 2>&1; ${inner}`)} ` +
			`< /dev/null > /dev/null 2>&1 & echo $!`;
		const started = await this.client.exec(machine.id, ['sh', '-c', launch]);
		const pid = Number.parseInt(started.stdout.trim(), 10);
		if (started.exitCode !== 0 || !Number.isInteger(pid)) {
			throw new Error(`boxd process start failed: ${started.stderr || started.stdout}`);
		}
		const exec = (c: string) => this.exec(c);
		const execProbe = (c: string) =>
			this.exec(c, { timeout: PROBE_TIMEOUT_MS }).catch(() => ({ success: false }));
		const readLogs = async () => (await exec(`cat ${logPath} 2>/dev/null || true`)).stdout;

		return {
			id: `boxd-proc-${machine.id}-${pid}`,
			command: cmd,
			async kill(signal?: string): Promise<void> {
				const name = (signal ?? 'TERM').replace(/^SIG/, '');
				const sig = /^[A-Z0-9]+$/.test(name) ? name : 'TERM';
				await exec(`kill -${sig} -- -${pid} 2>/dev/null || true`).catch(() => {});
			},
			async waitForPort(port: number, opts?: WaitForPortOptions): Promise<void> {
				const timeout = opts?.timeout ?? 30_000;
				const probe =
					`python3 -c "import socket,sys; s=socket.socket(); s.settimeout(1); ` +
					`sys.exit(0 if s.connect_ex(('127.0.0.1',${port}))==0 else 1)"`;
				await pollUntilReady(async () => (await execProbe(probe)).success, {
					timeoutMs: timeout,
					intervalMs: 500,
					timeoutMessage: async () =>
						`timed out waiting for port ${port} after ${timeout}ms.\n${await readLogs()}`,
				});
			},
			async getLogs(): Promise<{ stdout: string; stderr: string }> {
				return { stdout: await readLogs(), stderr: '' };
			},
		};
	}

	async launchProcess(cmd: string, options: LaunchProcessOptions): Promise<SandboxLaunchResult> {
		const built = buildLaunchCommand({
			setup: options.setup,
			command: cmd,
			port: options.port,
			startupTimeout: options.startupTimeout,
		});
		const launchStarted = Date.now();
		let process: SandboxProcess;
		try {
			process = await this.startProcess(built.command, {
				cwd: options.cwd,
				env: options.env,
				processId: options.processId,
			});
		} catch (error) {
			return transportFailureResult(error, {
				setup: 0,
				start: Math.max(0, Date.now() - launchStarted),
				waitport: 0,
			});
		}

		const start = Math.max(0, Date.now() - launchStarted);
		const waitStarted = Date.now();
		const deadline =
			options.startupTimeout === 0 ? undefined : launchStarted + options.startupTimeout;
		let setupCompleted = false;

		while (true) {
			let logs: { stdout: string; stderr: string };
			try {
				logs = await process.getLogs();
			} catch (error) {
				await process.kill().catch(() => {});
				return transportFailureResult(error, {
					setup: 0,
					start,
					waitport: Math.max(0, Date.now() - waitStarted),
				});
			}

			setupCompleted ||= `${logs.stdout}\n${logs.stderr}`.includes(
				setupCompleteMarker(built.nonce),
			);
			const parsed = parseLaunchOutput(logs, built.nonce);
			const outcome = parsed.outcome;
			if (outcome) {
				if (outcome.kind === 'ready') {
					return {
						success: true,
						process,
						timings: { setup: outcome.setupMs, start, waitport: outcome.waitportMs },
					};
				}
				return launchOutcomeResult(outcome.kind, outcome, parsed, start);
			}

			const now = Date.now();
			if (deadline !== undefined && now >= deadline + LAUNCH_MARKER_GRACE_MS) {
				await process.kill().catch(() => {});
				return launchTimeoutResult({
					setup: Boolean(options.setup),
					setupCompleted,
					startupTimeout: options.startupTimeout,
					output: parsed,
					start,
					waitport: Math.max(0, now - waitStarted),
				});
			}

			const sleepFor =
				deadline === undefined
					? LAUNCH_POLL_INTERVAL_MS
					: Math.min(LAUNCH_POLL_INTERVAL_MS, Math.max(1, deadline + LAUNCH_MARKER_GRACE_MS - now));
			await sleep(sleepFor);
		}
	}

	async exposePort(port: number, _options: ExposePortOptions): Promise<ExposePortResult> {
		const machine = await this.ensure();
		return { url: await this.client.route(machine.id, port, routeName(port)) };
	}

	private async destroyExisting(id: string): Promise<void> {
		try {
			await this.client.delete(id);
		} catch (error) {
			// A failed delete is safe to ignore only after confirming the machine is gone.
			if ((await this.owned()).some((m) => m.id === id && m.status !== 'destroyed')) throw error;
		}
	}

	destroy(): Promise<void> {
		if (this.state.destroyPromise) return this.state.destroyPromise;
		this.state.destroyGeneration = (this.state.destroyGeneration ?? 0) + 1;

		const pending = this.state.machinePromise;
		const attached = this.attachmentState.machinePromise;
		this.state.machinePromise = undefined;
		this.attachmentState.machinePromise = undefined;
		const promise = (async () => {
			const destroyed = new Set<string>();
			for (const handle of [pending, attached]) {
				const cached = await handle?.catch(() => null);
				if (cached && !destroyed.has(cached.id)) {
					await this.destroyExisting(cached.id);
					destroyed.add(cached.id);
				}
			}
			for (const match of await this.owned()) {
				if (destroyed.has(match.id)) continue;
				await this.destroyExisting(match.id);
				destroyed.add(match.id);
			}
		})();
		this.state.destroyPromise = promise;
		const releaseState = this.retainState();
		const release = () => {
			if (this.state.destroyPromise === promise) this.state.destroyPromise = undefined;
			releaseState();
		};
		void promise.then(release, release);
		return promise;
	}
}

export class BoxdCompute implements SandboxProvider {
	readonly capabilities = { multiPort: true } as const;
	private client?: BoxdClient;
	private readonly sandboxStates = new Map<SandboxId, BoxdSandboxStateEntry>();
	private readonly sandboxStateFinalizer = new FinalizationRegistry<{
		id: SandboxId;
		ref: WeakRef<BoxdSandboxState>;
	}>(({ id, ref }) => {
		if (this.sandboxStates.get(id)?.ref === ref) this.sandboxStates.delete(id);
	});

	constructor(
		private readonly config: BoxdConfig,
		client?: BoxdClient,
	) {
		this.client = client;
	}

	private getClient(): BoxdClient {
		if (!this.client) this.client = createBoxdClient(this.config);
		return this.client;
	}

	private retainSandboxState(entry: BoxdSandboxStateEntry, state: BoxdSandboxState): () => void {
		entry.retainCount += 1;
		entry.retained = state;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			entry.retainCount -= 1;
			if (entry.retainCount === 0) entry.retained = undefined;
		};
	}

	create(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		return this.instance(id, options, false);
	}

	connectExisting(id: SandboxId, options?: CreateSandboxOptions): SandboxInstance {
		return this.instance(id, options, true);
	}

	private instance(
		id: SandboxId,
		options: CreateSandboxOptions | undefined,
		existingOnly: boolean,
	): SandboxInstance {
		// For boxd the selectable "image" is a snapshot name.
		const config = options?.image ? { ...this.config, snapshot: options.image } : this.config;
		let entry = this.sandboxStates.get(id);
		let state = entry?.retained ?? entry?.ref.deref();
		if (!entry || !state) {
			state = {};
			const ref = new WeakRef(state);
			entry = { ref, retainCount: 0 };
			this.sandboxStates.set(id, entry);
			this.sandboxStateFinalizer.register(state, { id, ref });
		}
		const stateEntry = entry;
		return new BoxdSandboxInstance(
			id,
			config,
			this.getClient(),
			state,
			() => this.retainSandboxState(stateEntry, state),
			existingOnly,
		);
	}

	async proxy(_request: Request): Promise<Response | null> {
		// Kernels are reached directly at their machine's HTTPS route; nothing to proxy.
		return null;
	}

	async listActive(): Promise<ActiveSandbox[]> {
		const owner = this.config.ownerTag ?? DEFAULT_OWNER_TAG;
		const machines = await this.getClient().list({ [OWNER_LABEL]: owner });
		const active: ActiveSandbox[] = [];
		for (const m of machines) {
			const id = m.labels[ID_LABEL];
			// Stopped and failed machines are listed too, so the reconciler can reap them.
			if (m.labels[OWNER_LABEL] !== owner || m.status === 'destroyed') continue;
			if (SandboxId.is(id)) active.push({ id, createdAt: m.createdAt });
		}
		return active;
	}
}

/* oxlint-disable typescript/no-explicit-any -- `@boxd-sh/sdk` is an optional
   bring-your-own dependency loaded via runtime import(); `any` is the integration seam. */

/** The slice of `@boxd-sh/sdk` this client needs: the `Boxd` class and its errors. */
export interface BoxdSdk {
	Boxd: any;
	NotFoundError?: any;
}

function machineInfo(m: any): BoxdMachineInfo {
	return {
		id: m.id,
		name: m.name,
		status: m.status,
		createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : (m.createdAt ?? undefined),
		labels: m.labels ?? {},
	};
}

function queueToStream(queue: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
	const iterator = queue[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await iterator.next();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		async cancel() {
			await iterator.return?.();
		},
	});
}

/**
 * Default {@link BoxdClient}: a thin wrapper over `@boxd-sh/sdk`. By default the
 * SDK is loaded via a runtime `import()`, so it stays an optional, unbundled
 * dependency of the server image. Pass `loadSdk` to inject a statically imported
 * SDK instead.
 *
 * Every machine is created `isolated`: it never joins the org's private network
 * and holds no platform credentials, because notebooks run arbitrary code.
 */
export function createBoxdClient(
	config: BoxdConfig,
	loadSdk: () => Promise<BoxdSdk> = defaultLoadSdk,
): BoxdClient {
	if (!config.apiKey?.trim()) throw new Error('The boxd compute backend requires an API key');
	let boxdPromise: Promise<{ boxd: any; sdk: BoxdSdk }> | undefined;
	const sdkClient = () =>
		(boxdPromise ??= loadSdk().then((sdk) => ({
			sdk,
			boxd: new sdk.Boxd({
				apiKey: config.apiKey,
				...(config.region ? { region: config.region } : {}),
			}),
		})));
	const machines = async () => (await sdkClient()).boxd.machines;
	const org = config.org ? { org: config.org } : {};

	return {
		async create(options) {
			const m = await machines();
			const created = await m.create({
				name: options.name,
				labels: options.labels,
				isolated: true,
				...org,
				...(options.snapshot ? { fromSnapshot: options.snapshot } : {}),
				...(options.deleteAfterSeconds ? { deleteAfter: options.deleteAfterSeconds } : {}),
			});
			try {
				return machineInfo(await m.waitUntilReady(created.id));
			} catch (error) {
				await m.delete(created.id).catch(() => {});
				throw error;
			}
		},
		async waitUntilReady(id) {
			return machineInfo(await (await machines()).waitUntilReady(id));
		},
		async list(labels) {
			const list = await (await machines()).list({ ...org, labels });
			return [...list].map(machineInfo);
		},
		async start(id) {
			const m = await machines();
			await m.start(id);
			return machineInfo(await m.waitUntilReady(id));
		},
		async exec(id, argv, options) {
			const r = await (
				await machines()
			).exec(id, {
				command: argv,
				...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
			});
			return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
		},
		execStream(id, argv) {
			let stream: any;
			const opened = machines().then((m) => {
				stream = m.streamExec(id, { command: argv, closeStdin: true });
				return stream;
			});
			const lazyQueue = (key: 'stdout' | 'stderr'): AsyncIterable<Uint8Array> => ({
				async *[Symbol.asyncIterator]() {
					yield* (await opened)[key];
				},
			});
			return {
				stdout: queueToStream(lazyQueue('stdout')),
				stderr: queueToStream(lazyQueue('stderr')),
				wait: async () => (await opened).wait(),
				close: () => {
					if (stream) stream.close();
					else
						void opened.then(
							(s) => s.close(),
							() => {},
						);
				},
			};
		},
		async upload(id, path, content) {
			await (await machines()).files.upload(id, path, content);
		},
		async download(id, path) {
			return (await machines()).files.download(id, path);
		},
		async route(id, port, name) {
			const m = await machines();
			if (name) {
				const existing = (await m.proxies.list(id)).find((p: any) => p.name === name);
				if (!existing) await m.proxies.create(id, name, port);
				else if (existing.port !== port) await m.proxies.setPort(id, port, { name });
			} else {
				await m.proxies.setPort(id, port);
				// The kernel route serves fetches from the hub and the browser alike.
				await m.setBotProtection(id, 'off');
			}
			const route = (await m.proxies.list(id)).find((p: any) =>
				name ? p.name === name : p.isDefault,
			);
			if (!route) throw new Error(`boxd route for port ${port} was not created`);
			return `https://${route.domain}`;
		},
		async delete(id) {
			const { sdk } = await sdkClient();
			try {
				await (await machines()).delete(id);
			} catch (error) {
				if (sdk.NotFoundError && error instanceof sdk.NotFoundError) return;
				throw error;
			}
		},
	};
}

/** Default SDK loader: a runtime `import('@boxd-sh/sdk')`, left unbundled for the Node image. */
async function defaultLoadSdk(): Promise<BoxdSdk> {
	const moduleName = '@boxd-sh/sdk';
	try {
		return (await import(/* @vite-ignore */ moduleName)) as BoxdSdk;
	} catch (err) {
		throw new Error(
			"MARIMOHUB_COMPUTE_BACKEND=boxd requires the '@boxd-sh/sdk' package. Run " +
				'`pnpm add @boxd-sh/sdk` and bake it into the server image, or inject it via ' +
				`createBoxdClient's \`loadSdk\`. (${errorMessage(err)})`,
		);
	}
}
/* oxlint-enable typescript/no-explicit-any */
