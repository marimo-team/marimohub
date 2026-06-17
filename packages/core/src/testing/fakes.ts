import type { SandboxId } from '../ids';
import type {
	ActiveSandbox,
	ExecResult,
	ExposePortOptions,
	MountBucketOptions,
	ReadFileResult,
	SandboxInstance,
	SandboxProcess,
	SandboxProvider,
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
	writeFile: { path: string; content: string }[];
	readFile: string[];
	waitForPort: number[];
	destroy: number;
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
		readFile: [],
		waitForPort: [],
		destroy: 0,
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
		writeFile: async (path: string, content: string) => {
			calls.writeFile.push({ path, content });
		},
		gitCheckout: async () => {},
		setEnvVars: async () => {},
		mountBucket: async (options: MountBucketOptions) => {
			calls.mountBucket.push(options);
			if (opts.failMount) {
				throw new Error('mount failed');
			}
		},
		unmountBucket: async () => {},
		startProcess: async (cmd: string, options?: StartProcessOptions) => {
			calls.startProcess.push({ cmd, options });
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

/** Wrap a `SandboxInstance` in a single-sandbox `SandboxProvider`. */
export function fakeComputeFrom(instance: SandboxInstance): SandboxProvider {
	return {
		create: () => instance,
		proxy: async () => null,
	};
}

/**
 * A healthy fake `SandboxProvider`. Pass `FakeSandboxOptions` to exercise failure
 * branches — e.g. `makeFakeCompute({ failExec: 'true' })` makes the reachability
 * check throw so provisioning rejects.
 */
export function makeFakeCompute(opts: FakeSandboxOptions = {}): SandboxProvider {
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
		// teardown() with used_fallback=false only calls destroy(); other methods
		// are never exercised by the reconciler tests.
		return {
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
