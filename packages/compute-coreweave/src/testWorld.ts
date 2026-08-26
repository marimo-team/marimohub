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
} from '@coreweave/cwsandbox';
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

export interface FakeSandbox {
	sandboxId: string;
	runCalls: string[][];
	startCalls: string[][];
	/** One entry per `files.write(files)` call — the set sent in that call. */
	batchWrites: { path: string; content: unknown }[][];
	reads: Record<string, string>;
	deleted: number;
	/** One entry per `wait()` call, carrying the options the adapter passed. */
	waitCalls: { intervalMs?: number }[];
}

// `FileWrites` also admits a path→content record, but the adapter only ever
// sends the array form; normalize so the fake satisfies the SDK type.
function recordWrite(fake: FakeSandbox) {
	return async (files: FileWrites): Promise<void> => {
		const list = Array.isArray(files)
			? (files as readonly { path: string; content: unknown }[]).map((f) => ({ ...f }))
			: Object.entries(files).map(([path, content]) => ({ path, content }));
		fake.batchWrites.push(list);
	};
}

export function makeWorld(opts?: {
	runImpl?: (cmd: readonly string[]) => Promise<ProcessResult>;
	startImpl?: (cmd: readonly string[]) => Promise<CommandProcess>;
	/** Runs inside the boot `wait()`; use it to simulate a slow boot. */
	waitImpl?: () => Promise<void>;
	/** State for started processes; omit to leave them running. */
	proc?: FakeProcessState;
}) {
	const created: NonNullable<Parameters<CoreWeaveClient['create']>[0]>[] = [];
	const deleted: string[] = [];
	const listCalls: (readonly string[])[] = [];
	const registry = new Map<string, { fake: FakeSandbox; tags: string[] }>();
	let seq = 0;
	const runImpl = opts?.runImpl ?? (async () => procResult());
	const waitImpl = opts?.waitImpl ?? (async () => {});

	function build(sandboxId: string) {
		const fake: FakeSandbox = {
			sandboxId,
			runCalls: [],
			startCalls: [],
			batchWrites: [],
			reads: {},
			deleted: 0,
			waitCalls: [],
		};
		const sandbox = {
			sandboxId,
			wait: async (options?: { intervalMs?: number }) => {
				fake.waitCalls.push(options ?? {});
				await waitImpl();
			},
			commands: {
				run: async (command: readonly string[]) => {
					fake.runCalls.push([...command]);
					return runImpl(command);
				},
				start: async (command: readonly string[]) => {
					fake.startCalls.push([...command]);
					return opts?.startImpl?.(command) ?? fakeProcess(opts?.proc);
				},
			},
			files: {
				readText: async (path: string) => {
					if (path in fake.reads) return fake.reads[path];
					throw new Error('not found');
				},
				write: recordWrite(fake),
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
			const { fake, sandbox } = build(cwId);
			registry.set(cwId, { fake, tags: [...(options?.tags ?? [])] });
			return sandbox;
		},
		fromId: async (cwId) => {
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
					sandboxes.push({ sandboxId: cwId, status: 'running' });
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
	function reconnect(entry: { fake: FakeSandbox }, cwId: string) {
		return {
			sandboxId: cwId,
			wait: async (options?: { intervalMs?: number }) => {
				entry.fake.waitCalls.push(options ?? {});
			},
			commands: {
				run: async (command: readonly string[]) => {
					entry.fake.runCalls.push([...command]);
					return runImpl(command);
				},
				start: async (command: readonly string[]) => {
					entry.fake.startCalls.push([...command]);
					return opts?.startImpl?.(command) ?? fakeProcess();
				},
			},
			files: {
				readText: async (path: string) => {
					if (path in entry.fake.reads) return entry.fake.reads[path];
					throw new Error('not found');
				},
				write: recordWrite(entry.fake),
			},
			delete: async () => {
				entry.fake.deleted++;
				deleted.push(cwId);
				registry.delete(cwId);
			},
		};
	}

	return { client, created, deleted, listCalls, registry };
}
