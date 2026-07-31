import type { SandboxId } from '../ids';
import type {
	ActiveSandbox,
	CreateSandboxOptions,
	ExecResult,
	ExposePortOptions,
	FileInfo,
	ListFilesResult,
	MountBucketOptions,
	ReadFileResult,
	SandboxFileWrite,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
	SetEnvVarsOptions,
	StartProcessOptions,
} from '../ports/sandbox';

/** URL the fake sandbox reports from `exposePort`. */
export const EXPOSED_URL = 'https://sandbox.example/kernel';

/** Records every call the provision/teardown paths make against a fake sandbox. */
export interface SandboxCalls {
	exec: string[];
	mountBucket: MountBucketOptions[];
	startProcess: { cmd: string; options?: StartProcessOptions }[];
	exposePort: { port: number; options: ExposePortOptions }[];
	/** Every file written, flattened across calls — for "was X written?" assertions. */
	writeFile: { path: string; content: string | Uint8Array }[];
	/** One entry per `writeFiles` call (the set sent in that call) — for batching assertions. */
	writeFiles: SandboxFileWrite[][];
	setEnvVars: Record<string, string>[];
	/** Vars set with `onlyIfUnset` (`SessionEnv.defaults`), recorded separately. */
	setEnvDefaults: Record<string, string>[];
	readFile: string[];
	waitForPort: number[];
	destroy: number;
	/** Method names in call order (for the methods that record), for ordering assertions. */
	sequence: string[];
}

export interface FakeSandboxOptions {
	/** When set, `exec(cmd)` rejects if `cmd` matches this value. */
	failExec?: string;
	/** When true, `mountBucket` rejects (forcing the manual-copy fallback path). */
	failMount?: boolean;
	/** Files the sandbox reports as present when `readFile` is called. */
	files?: Record<string, string>;
}

/**
 * A fully-typed fake `SandboxInstance` that records its calls. Covers the methods
 * the provision/teardown path exercises (exec, mountBucket, startProcess →
 * waitForPort, exposePort, writeFile/readFile, destroy); options toggle the
 * unreachable-exec and mount-failure branches.
 */
export function makeFakeSandbox(opts: FakeSandboxOptions = {}): {
	instance: SandboxInstance;
	calls: SandboxCalls;
} {
	const calls: SandboxCalls = {
		exec: [],
		mountBucket: [],
		startProcess: [],
		exposePort: [],
		writeFile: [],
		writeFiles: [],
		setEnvVars: [],
		setEnvDefaults: [],
		readFile: [],
		waitForPort: [],
		destroy: 0,
		sequence: [],
	};

	const process: SandboxProcess = {
		id: 'proc_1',
		command: 'uv run marimo edit',
		kill: async () => {},
		waitForPort: async (port: number) => {
			calls.waitForPort.push(port);
		},
		getLogs: async () => ({ stdout: '', stderr: '' }),
	};

	const instance: SandboxInstance = {
		exec: async (cmd: string): Promise<ExecResult> => {
			calls.exec.push(cmd);
			if (opts.failExec !== undefined && cmd === opts.failExec) {
				throw new Error('sandbox unreachable');
			}
			return { success: true, stdout: '', stderr: '' };
		},
		execStream: async () => new ReadableStream(),
		readFile: async (path: string): Promise<ReadFileResult> => {
			calls.readFile.push(path);
			const content = opts.files?.[path];
			if (content === undefined) {
				return { success: false, content: '' };
			}
			return { success: true, content };
		},
		listFiles: async () => ({ success: true, files: [] }),
		writeFiles: async (files: readonly SandboxFileWrite[]) => {
			calls.writeFiles.push([...files]);
			calls.writeFile.push(...files);
			calls.sequence.push('writeFiles');
		},
		gitCheckout: async () => {},
		setEnvVars: async (vars: Record<string, string>, options?: SetEnvVarsOptions) => {
			if (options?.onlyIfUnset) {
				calls.setEnvDefaults.push(vars);
				calls.sequence.push('setEnvDefaults');
			} else {
				calls.setEnvVars.push(vars);
				calls.sequence.push('setEnvVars');
			}
		},
		mountBucket: async (options: MountBucketOptions) => {
			calls.mountBucket.push(options);
			if (opts.failMount) {
				throw new Error('mount failed');
			}
		},
		unmountBucket: async () => {},
		startProcess: async (cmd: string, options?: StartProcessOptions) => {
			calls.startProcess.push({ cmd, options });
			calls.sequence.push('startProcess');
			return process;
		},
		exposePort: async (port: number, options: ExposePortOptions) => {
			calls.exposePort.push({ port, options });
			return { url: EXPOSED_URL };
		},
		destroy: async () => {
			calls.destroy++;
		},
	};

	return { instance, calls };
}

const DEFAULT_FS_ROOT = '/workspace';

function fsBase64Encode(bytes: Uint8Array): string {
	let bin = '';
	for (const byte of bytes) bin += String.fromCharCode(byte);
	return btoa(bin);
}

/** Strip the single-quote wrapping `shellQuote` adds, undoing the `'\''` escape. */
function fsUnquote(s: string): string {
	return s.replace(/^'/, '').replace(/'$/, '').replaceAll(`'\\''`, `'`);
}

export interface FsSandboxOptions {
	/** Absolute mount root the in-memory filesystem is anchored at. */
	root?: string;
	/** Initial files, keyed by path relative to `root` (string or raw bytes). */
	files?: Record<string, string | Uint8Array>;
	/**
	 * Overrides the size `listFiles` reports for a relative path, decoupling the
	 * declared size from the stored payload. Lets size-cap tests declare large
	 * files without allocating (and base64-round-tripping) the bytes — the capture
	 * caps key off the *listed* size, not a read.
	 */
	sizes?: Record<string, number>;
}

/**
 * A fake `SandboxInstance` backed by an in-memory filesystem (relative path →
 * bytes) anchored at `root`. Unlike `makeFakeSandbox` (which only records calls),
 * this one actually round-trips file contents, so it exercises the real
 * `sandboxFiles` codec:
 *   - restore stores the bytes `writeFiles` hands over, verbatim;
 *   - capture emits `base64 -w0 <path>`, since reads still come back over `exec`;
 *   - `listFiles` reports current contents with real byte sizes;
 *   - `readFile` returns stored content (decoded as UTF-8).
 *
 * Returns the live `fs` map (for content assertions) and a `SandboxCalls` record
 * so tests can assert a path was *never* read (e.g. skipped before buffering).
 */
export function makeFsSandbox(opts: FsSandboxOptions = {}): {
	instance: SandboxInstance;
	fs: Map<string, Uint8Array>;
	calls: SandboxCalls;
} {
	const root = opts.root ?? DEFAULT_FS_ROOT;
	const enc = (s: string) => new TextEncoder().encode(s);
	const fs = new Map<string, Uint8Array>(
		Object.entries(opts.files ?? {}).map(([rel, v]) => [rel, typeof v === 'string' ? enc(v) : v]),
	);
	const calls: SandboxCalls = {
		exec: [],
		mountBucket: [],
		startProcess: [],
		exposePort: [],
		writeFile: [],
		writeFiles: [],
		setEnvVars: [],
		setEnvDefaults: [],
		readFile: [],
		waitForPort: [],
		destroy: 0,
		sequence: [],
	};

	/** Map an absolute (or already-relative) path to its `fs` key. */
	const toRel = (path: string) =>
		path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

	const instance = {
		async exec(cmd: string): Promise<ExecResult> {
			calls.exec.push(cmd);
			// Capture: base64 -w0 '<path>'
			const capture = cmd.match(/^base64 -w0 (.+)$/);
			if (capture) {
				const rel = toRel(fsUnquote(capture[1]));
				const bytes = fs.get(rel);
				if (bytes === undefined) return { success: false, stdout: '', stderr: 'not found' };
				return { success: true, stdout: fsBase64Encode(bytes), stderr: '' };
			}
			// mkdir -p ... (and any other prep command): no-op success.
			return { success: true, stdout: '', stderr: '' };
		},
		async execStream() {
			return new ReadableStream();
		},
		async readFile(path: string): Promise<ReadFileResult> {
			calls.readFile.push(path);
			const bytes = fs.get(toRel(path));
			if (bytes === undefined) return { success: false, content: '' };
			return { success: true, content: new TextDecoder().decode(bytes), encoding: 'utf-8' };
		},
		async listFiles(path: string): Promise<ListFilesResult> {
			const files: FileInfo[] = [...fs.entries()]
				.filter(([rel]) => {
					const abs = `${root}/${rel}`;
					return abs === path || abs.startsWith(`${path}/`);
				})
				.map(([rel, bytes]) => ({
					name: rel.split('/').pop() ?? rel,
					absolutePath: `${root}/${rel}`,
					relativePath: rel,
					type: 'file' as const,
					size: opts.sizes?.[rel] ?? bytes.length,
				}));
			return { success: true, files };
		},
		async writeFiles(files: readonly SandboxFileWrite[]) {
			calls.writeFiles.push([...files]);
			calls.writeFile.push(...files);
			for (const f of files) {
				// Bytes are stored verbatim; only string content is encoded. Passing a
				// Uint8Array through `enc` would stringify it ("1,2,3") and store garbage.
				fs.set(toRel(f.path), typeof f.content === 'string' ? enc(f.content) : f.content);
			}
		},
		async gitCheckout() {},
		async setEnvVars() {},
		async mountBucket() {},
		async unmountBucket() {},
		async startProcess() {
			throw new Error('not implemented');
		},
		async exposePort() {
			return { url: EXPOSED_URL };
		},
		async destroy() {
			calls.destroy++;
		},
	} satisfies SandboxInstance;

	return { instance, fs, calls };
}

/** A fake `SandboxProvider` that records the options of its last `create` call. */
export interface FakeCompute extends SandboxProvider {
	lastCreateOptions?: CreateSandboxOptions;
}

/** Wrap a `SandboxInstance` in a single-sandbox `SandboxProvider`. */
export function fakeComputeFrom(instance: SandboxInstance): FakeCompute {
	const provider: FakeCompute = {
		create(_id, options) {
			provider.lastCreateOptions = options;
			return instance;
		},
		proxy: async () => null,
	};
	return provider;
}

/**
 * A healthy fake `SandboxProvider`. Pass `FakeSandboxOptions` to exercise failure
 * branches — e.g. `makeFakeCompute({ failExec: 'true' })` makes the reachability
 * check throw so provisioning rejects.
 */
export function makeFakeCompute(opts: FakeSandboxOptions = {}): FakeCompute {
	return fakeComputeFrom(makeFakeSandbox(opts).instance);
}

/**
 * A no-op `SandboxProvider` for routes that never provision a sandbox. `proxy`
 * returns null; `create` throws to surface accidental provisioning in tests.
 */
export const noopCompute: SandboxProvider = {
	create: () => {
		throw new Error('noopCompute.create() should not be called');
	},
	proxy: async () => null,
};

/**
 * A `SandboxProvider` double for the reconciler: records which sandbox ids get
 * destroyed and lets a test set what `listActive()` reports as the provider's
 * live truth.
 */
export class RecordingCompute implements SandboxProvider {
	readonly destroyed: string[] = [];
	active: ActiveSandbox[] = [];

	create(id: SandboxId): SandboxInstance {
		const destroyed = this.destroyed;
		// The reconciler's save-on-reap reads session artifacts off the sandbox
		// before destroying it; the fake reports no files so `commitSession` runs
		// with empty artifacts. `destroy()` records the teardown.
		return {
			async readFile() {
				return { success: false as const };
			},
			async listFiles() {
				return { success: false as const, files: [] };
			},
			async destroy() {
				destroyed.push(id);
			},
		} as unknown as SandboxInstance;
	}

	async proxy(): Promise<Response | null> {
		return null;
	}

	async listActive(): Promise<ActiveSandbox[]> {
		return this.active;
	}
}
