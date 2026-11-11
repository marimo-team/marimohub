/**
 * Test-only hermetic fake for the CoreWeave adapter, shared by `index.test.ts`
 * and `wandb.test.ts` (no gRPC, no live creds). Not exported from the package.
 *
 * The fake keeps a registry of created sandboxes keyed by the CoreWeave id it
 * assigns, so reconnect/list/delete-by-tag behave realistically.
 */
import type {
	CommandProcess,
	CommandProcessStatus,
	FileWrites,
	ProcessResult,
	SandboxInfo,
	SandboxStatus,
	Service,
	ServiceUrl,
} from '@coreweave/cwsandbox';
import { CWSandboxTimeoutError } from '@coreweave/cwsandbox';
import { scriptContractLaunch } from '@marimo-hub/core/testing/compute-contract';
import type { CoreWeaveClient } from './index';

export function procResult(over: Partial<ProcessResult> = {}): ProcessResult {
	return {
		command: ['sh'] as unknown as ProcessResult['command'],
		exitCode: 0,
		failed: false,
		ok: true,
		stderr: '',
		stderrBytes: new Uint8Array(),
		stderrBytesProduced: 0,
		stderrTruncated: false,
		stdout: '',
		stdoutBytes: new Uint8Array(),
		stdoutBytesProduced: 0,
		stdoutTruncated: false,
		...over,
	};
}

/** How a started process should present itself: still running unless told otherwise. */
export interface FakeProcessState {
	exitCode?: number;
	status?: CommandProcessStatus;
}

/**
 * Mirrors the SDK's own state machine: an exit code is recorded ONLY on a clean
 * exit, so a `failed` (stream fault) or `cancelled` process reports its status
 * with `exitCode`/`poll()` left undefined.
 */
export function fakeProcess(state?: FakeProcessState): CommandProcess {
	async function* empty(): AsyncGenerator<string> {
		// no output
	}
	const status = state?.status ?? (state?.exitCode === undefined ? 'running' : 'exited');
	const exitCode = status === 'exited' ? state?.exitCode : undefined;
	return {
		command: ['sh'] as unknown as CommandProcess['command'],
		exitCode,
		status,
		stdout: empty(),
		stderr: empty(),
		cancel: async () => {},
		poll: () => exitCode,
		wait: async () => procResult({ exitCode }),
	};
}

/**
 * `startImpl` piece for the compute contract's `launchProcess` cases: the
 * adapter watches the started command's live streams for supervisor markers, so
 * the fake emits the scripted transcript on stderr and stays "running".
 * Returns undefined for anything that is not a contract launch.
 */
export function contractLaunchProcess(command: readonly string[]): CommandProcess | undefined {
	const launch = scriptContractLaunch(command.at(-1));
	if (!launch) return undefined;
	async function* transcript(): AsyncGenerator<string> {
		yield launch!.transcript;
	}
	async function* empty(): AsyncGenerator<string> {
		// no output
	}
	return {
		command: ['sh'] as unknown as CommandProcess['command'],
		exitCode: undefined,
		status: 'running',
		stdout: empty(),
		stderr: transcript(),
		cancel: async () => {},
		poll: () => {},
		wait: async () => procResult(),
	};
}

export interface FakeSandbox {
	sandboxId: string;
	status: SandboxStatus;
	serviceUrls: ServiceUrl[];
	runCalls: string[][];
	startCalls: string[][];
	stdinWrites: (string | Uint8Array)[];
	/** One entry per `files.write(files)` call — the set sent in that call. */
	batchWrites: { path: string; content: unknown }[][];
	reads: Record<string, string>;
	deleted: number;
	/** Number of `getStatus()` calls the adapter issued. */
	statusPolls: number;
}

type WriteOptions = { timeoutMs?: number; signal?: AbortSignal };
type WriteImpl = (files: FileWrites, options?: WriteOptions) => Promise<void>;

// `FileWrites` also admits a path→content record, but the adapter only ever
// sends the array form; normalize so the fake satisfies the SDK type.
function recordWrite(fake: FakeSandbox, writeImpl?: WriteImpl) {
	return async (files: FileWrites, options?: WriteOptions): Promise<void> => {
		const write = writeImpl?.(files, options);
		const timeoutMs = options?.timeoutMs;
		// Mirror the SDK's per-RPC deadline so a hung fake write fails like a real one.
		if (write && timeoutMs !== undefined) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					write,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new CWSandboxTimeoutError('file write deadline exceeded')),
							timeoutMs,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		} else await write;
		const list = Array.isArray(files)
			? (files as readonly { path: string; content: unknown }[]).map((f) => ({ ...f }))
			: Object.entries(files).map(([path, content]) => ({ path, content }));
		fake.batchWrites.push(list);
	};
}

export function makeWorld(opts?: {
	runImpl?: (cmd: readonly string[]) => Promise<ProcessResult>;
	startImpl?: (cmd: readonly string[]) => Promise<CommandProcess>;
	inputImpl?: (cmd: readonly string[], input: string | Uint8Array) => Promise<void>;
	/** Runs inside each `getStatus()` poll; use it to simulate a slow or failing Get. */
	pollImpl?: () => Promise<void>;
	/** Status of newly created sandboxes. Default `running`. */
	bootStatus?: SandboxStatus;
	/** Runs before each `files.write`; throw to fail that write. */
	writeImpl?: WriteImpl;
	/** State for started processes; omit to leave them running. */
	proc?: FakeProcessState;
}) {
	const created: NonNullable<Parameters<CoreWeaveClient['create']>[0]>[] = [];
	const createdFromTemplate: {
		templateId: string;
		options: NonNullable<Parameters<CoreWeaveClient['runFromTemplate']>[1]>;
	}[] = [];
	const deleted: string[] = [];
	const listCalls: (readonly string[])[] = [];
	const fromIdCalls: string[] = [];
	const registry = new Map<string, { fake: FakeSandbox; tags: string[] }>();
	let seq = 0;
	const runImpl = opts?.runImpl ?? (async () => procResult());
	const pollImpl = opts?.pollImpl ?? (async () => {});

	function build(sandboxId: string, services: readonly Service[] = []) {
		const fake: FakeSandbox = {
			sandboxId,
			status: opts?.bootStatus ?? 'running',
			serviceUrls: services.map((service) => ({
				name: service.name ?? `port-${service.port}`,
				port: service.port,
				url: `${service.endpoint?.kind === 'https' ? 'https' : 'http'}://${sandboxId}-${service.port}.sandbox.test`,
			})),
			runCalls: [],
			startCalls: [],
			stdinWrites: [],
			batchWrites: [],
			reads: {},
			deleted: 0,
			statusPolls: 0,
		};
		const sandbox = {
			sandboxId,
			get status() {
				return fake.status;
			},
			get serviceUrls() {
				return fake.serviceUrls;
			},
			getStatus: async () => {
				fake.statusPolls++;
				await pollImpl();
				return fake.status;
			},
			commands: {
				run: async (command: readonly string[]) => {
					fake.runCalls.push([...command]);
					return runImpl(command);
				},
				start: async (command: readonly string[], options?: { stdin?: boolean }) => {
					fake.startCalls.push([...command]);
					if (options?.stdin)
						return {
							...fakeProcess({ exitCode: 0 }),
							stdin: {
								write: async (content: string | Uint8Array) => {
									fake.stdinWrites.push(content);
									await opts?.inputImpl?.(command, content);
								},
								close: async () => {},
							},
						};
					return opts?.startImpl?.(command) ?? fakeProcess(opts?.proc);
				},
			},
			files: {
				readText: async (path: string) => {
					if (path in fake.reads) return fake.reads[path];
					throw new Error('not found');
				},
				write: recordWrite(fake, opts?.writeImpl),
			},
			delete: async () => {
				fake.deleted++;
				deleted.push(sandboxId);
				registry.delete(sandboxId);
			},
		};
		return { fake, sandbox };
	}

	const client: CoreWeaveClient = {
		create: async (options) => {
			created.push(options!);
			const cwId = `cw-${++seq}`;
			const { fake, sandbox } = build(cwId, options?.services);
			registry.set(cwId, { fake, tags: [...(options?.tags ?? [])] });
			return sandbox;
		},
		runFromTemplate: async (templateId, options) => {
			createdFromTemplate.push({ templateId, options: options ?? {} });
			const cwId = `cw-${++seq}`;
			const { fake, sandbox } = build(cwId, options?.services);
			registry.set(cwId, { fake, tags: [...(options?.tags ?? [])] });
			return sandbox;
		},
		fromId: async (cwId) => {
			fromIdCalls.push(cwId);
			const entry = registry.get(cwId);
			if (!entry) throw new Error(`no sandbox ${cwId}`);
			return reconnect(entry, cwId);
		},
		list: async (options) => {
			const tags = options?.tags ?? [];
			listCalls.push(tags);
			const sandboxes: SandboxInfo[] = [];
			for (const [cwId, entry] of registry) {
				if (tags.every((t) => entry.tags.includes(t))) {
					sandboxes.push({ sandboxId: cwId, status: entry.fake.status });
				}
			}
			return { sandboxes };
		},
		delete: async (cwId) => {
			deleted.push(cwId);
			registry.delete(cwId);
		},
	};

	// Reconnect returns a handle backed by the SAME recorded FakeSandbox state.
	function reconnect(entry: { fake: FakeSandbox; tags: string[] }, cwId: string) {
		return {
			sandboxId: cwId,
			tags: entry.tags,
			get status() {
				return entry.fake.status;
			},
			get serviceUrls() {
				return entry.fake.serviceUrls;
			},
			getStatus: async () => {
				entry.fake.statusPolls++;
				await pollImpl();
				return entry.fake.status;
			},
			commands: {
				run: async (command: readonly string[]) => {
					entry.fake.runCalls.push([...command]);
					return runImpl(command);
				},
				start: async (command: readonly string[], options?: { stdin?: boolean }) => {
					entry.fake.startCalls.push([...command]);
					if (options?.stdin)
						return {
							...fakeProcess({ exitCode: 0 }),
							stdin: {
								write: async (content: string | Uint8Array) => {
									entry.fake.stdinWrites.push(content);
									await opts?.inputImpl?.(command, content);
								},
								close: async () => {},
							},
						};
					return opts?.startImpl?.(command) ?? fakeProcess();
				},
			},
			files: {
				readText: async (path: string) => {
					if (path in entry.fake.reads) return entry.fake.reads[path];
					throw new Error('not found');
				},
				write: recordWrite(entry.fake, opts?.writeImpl),
			},
			delete: async () => {
				entry.fake.deleted++;
				deleted.push(cwId);
				registry.delete(cwId);
			},
		};
	}

	return { client, created, createdFromTemplate, deleted, fromIdCalls, listCalls, registry };
}
