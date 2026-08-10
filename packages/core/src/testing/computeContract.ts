/**
 * Shared structural contract for any `SandboxProvider`.
 *
 * Compute adapters are translation layers: each maps the port onto a backend
 * SDK/HTTP/CLI and is mostly tested by asserting the calls it emits against a
 * backend-shaped fake. So unlike `bucketContract` (which verifies CAS behavior
 * against a faithful store), this contract pins the fake-agnostic invariants
 * every adapter must honor regardless of backend. Behavioral invariants are
 * opt-in through `semantics`; backend-specific translation details stay in each
 * adapter's own suite, where the fake models that backend.
 *
 * Imports `vitest` — only invoke from a `*.test.ts`. Exposed at the
 * `@marimo-hub/core/testing/compute-contract` subpath so it never reaches runtime.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SandboxId } from '../ids';
import type { SandboxInstance, SandboxProvider } from '../ports/sandbox';
import { expectExecResult, expectFileResult, expectListFilesResult } from './assertions';

export const CONTRACT_SANDBOX_ID = 'sb-aaaaaaaaaaaaaaaa' as SandboxId;
/** Fixed names the hidden-file semantic case asserts on; seeds must create both. */
export const CONTRACT_VISIBLE_FILE = 'contract-visible.txt';
export const CONTRACT_HIDDEN_FILE = '.contract-hidden';

const CONTRACT_ID = CONTRACT_SANDBOX_ID;

const REQUIRED_METHODS: (keyof SandboxInstance)[] = [
	'exec',
	'execStream',
	'readFile',
	'listFiles',
	'writeFiles',
	'gitCheckout',
	'setEnvVars',
	'mountBucket',
	'unmountBucket',
	'startProcess',
	'exposePort',
	'destroy',
];

/**
 * Capabilities an adapter may implement but need not. Present-but-not-a-function
 * is still a bug, so pin that rather than skipping them entirely.
 */
const OPTIONAL_METHODS: (keyof SandboxInstance)[] = ['drainTimings'];

export interface ComputeContractOptions {
	/**
	 * The adapter rejects `mountBucket` so the provisioner falls back to copying
	 * files in — true for every backend that can't mount the storage bucket
	 * natively (Modal, E2B, Docker, Podman, CoreWeave, Kubernetes).
	 */
	mountFallsBack?: boolean;
	/** Hostname passed to `exposePort`; some adapters embed it in the URL. */
	hostname?: string;
	semantics?: ComputeContractSemantics;
}

/**
 * Behavioral cases each backend/fake can opt into. Every field is optional:
 * a fake that cannot model a behavior omits the field and the case is skipped.
 */
export interface ComputeContractSemantics {
	/** Shell command guaranteed to exit non-zero in this backend/fake. */
	failingCommand?: string;
	/** A path guaranteed absent, plus the error code the adapter maps it to. */
	absentFile?: { path: string; code: 'NOT_FOUND' | 'READ_FAILED' };
	/** Directory listing whose seed creates the contract's visible and hidden fixtures. */
	hiddenFiles?: { dir: string; seed: (inst: SandboxInstance) => Promise<void> };
	/** Command whose stdout is the value of the named environment variable. */
	envProbe?: (name: string) => string;
}

export function computeContract(
	name: string,
	makeProvider: () => SandboxProvider | Promise<SandboxProvider>,
	opts: ComputeContractOptions = {},
): void {
	const hostname = opts.hostname ?? 'hub.example.com';
	const semantics = opts.semantics ?? {};

	describe(`Compute contract: ${name}`, () => {
		let provider: SandboxProvider;

		beforeEach(async () => {
			provider = await makeProvider();
		});

		it('create() exposes the full SandboxInstance method surface', () => {
			const inst = provider.create(CONTRACT_ID);
			for (const method of REQUIRED_METHODS) {
				expect(typeof inst[method], `${method} must be a function`).toBe('function');
			}
		});

		it('create() accepts a per-sandbox image override', async () => {
			// Only accept-and-run is contract-level; that the override actually reaches
			// the backend (run args, pod spec, template) is asserted per adapter.
			const inst = provider.create(CONTRACT_ID, { image: 'contract-image-override' });
			const res = await inst.exec('true');
			expect(typeof res.success).toBe('boolean');
		});

		it('optional capabilities are either absent or callable', () => {
			const inst = provider.create(CONTRACT_ID);
			for (const method of OPTIONAL_METHODS) {
				const impl = inst[method];
				expect(
					impl === undefined || typeof impl === 'function',
					`${method} must be a function when present`,
				).toBe(true);
			}
		});

		it('writeFiles accepts raw bytes (a backend must never stringify them)', async () => {
			const inst = provider.create(CONTRACT_ID);
			// Invalid UTF-8 with a NUL: a backend that round-trips through a string or a
			// JSON body mangles this, while ASCII bytes would sail through unnoticed.
			await expect(
				inst.writeFiles([
					{ path: '/tmp/contract.bin', content: new Uint8Array([0xff, 0xfe, 0x00, 0x80]) },
				]),
			).resolves.toBeUndefined();
		});

		it('writeFiles tolerates an empty set', async () => {
			await expect(provider.create(CONTRACT_ID).writeFiles([])).resolves.toBeUndefined();
		});

		it('exec returns a well-formed ExecResult', async () => {
			const res = await provider.create(CONTRACT_ID).exec('true');
			expect(typeof res.success).toBe('boolean');
			expect(typeof res.stdout).toBe('string');
			expect(typeof res.stderr).toBe('string');
		});

		it('execStream returns a readable stream', async () => {
			const stream = await provider.create(CONTRACT_ID).execStream('true');
			expect(stream).toBeInstanceOf(ReadableStream);
			await stream.cancel();
		});

		it('listFiles returns a well-formed ListFilesResult', async () => {
			const res = await provider.create(CONTRACT_ID).listFiles('/workspace');
			expectListFilesResult(res);
		});

		it('unmountBucket resolves', async () => {
			await expect(
				provider.create(CONTRACT_ID).unmountBucket('/workspace'),
			).resolves.toBeUndefined();
		});

		it('exposePort returns a parseable absolute URL', async () => {
			const inst = provider.create(CONTRACT_ID);
			// Materialise lazily-created backends before exposing a port.
			await inst.exec('true');
			const { url } = await inst.exposePort(2718, { hostname });
			expect(url).toBeTruthy();
			expect(() => new URL(url)).not.toThrow();
		});

		it('proxy() resolves to null or a Response (never throws)', async () => {
			const res = await provider.proxy(new Request('http://kernel.example/'));
			expect(res === null || res instanceof Response).toBe(true);
		});

		it('destroy() resolves', async () => {
			const inst = provider.create(CONTRACT_ID);
			await inst.exec('true');
			await expect(inst.destroy()).resolves.toBeUndefined();
		});

		if (opts.mountFallsBack) {
			it('mountBucket rejects so the provisioner falls back to file copy', async () => {
				await expect(
					provider.create(CONTRACT_ID).mountBucket({
						bucketName: 'b',
						endpoint: 'e',
						mountPath: '/m',
						prefix: 'p',
					}),
				).rejects.toThrow();
			});

			it('advertises supportsBucketMount: false so the provisioner skips the mount', () => {
				expect(provider.create(CONTRACT_ID).supportsBucketMount).toBe(false);
			});
		}

		if (semantics.failingCommand !== undefined) {
			const failingCommand = semantics.failingCommand;
			it('a nonzero-exit command maps to success:false with a typed error code', async () => {
				const res = await provider.create(CONTRACT_ID).exec(failingCommand);
				expectExecResult(res, { success: false });
			});
		}

		if (semantics.absentFile !== undefined) {
			const absentFile = semantics.absentFile;
			it('readFile of an absent path returns a typed failure, not a throw', async () => {
				const res = await provider.create(CONTRACT_ID).readFile(absentFile.path);
				expectFileResult(res, { success: false, error: { code: absentFile.code } });
			});
		}

		if (semantics.hiddenFiles !== undefined) {
			const hiddenFiles = semantics.hiddenFiles;
			it('listFiles hides dotfiles unless includeHidden is set', async () => {
				const inst = provider.create(CONTRACT_ID);
				await hiddenFiles.seed(inst);
				const byDefault = await inst.listFiles(hiddenFiles.dir);
				expectListFilesResult(byDefault, { success: true });
				const defaultNames = byDefault.files.map((f) => f.name);
				expect(defaultNames).toContain(CONTRACT_VISIBLE_FILE);
				expect(defaultNames).not.toContain(CONTRACT_HIDDEN_FILE);
				const withHidden = await inst.listFiles(hiddenFiles.dir, { includeHidden: true });
				expect(withHidden.files.map((f) => f.name)).toContain(CONTRACT_HIDDEN_FILE);
			});
		}

		if (semantics.envProbe !== undefined) {
			const envProbe = semantics.envProbe;
			it('setEnvVars onlyIfUnset defers to a var already set without onlyIfUnset', async () => {
				const inst = provider.create(CONTRACT_ID);
				await inst.setEnvVars({ MH_CONTRACT_ENV: 'forced' });
				await inst.setEnvVars({ MH_CONTRACT_ENV: 'default' }, { onlyIfUnset: true });
				const res = await inst.exec(envProbe('MH_CONTRACT_ENV'));
				expect(res.stdout.trim()).toBe('forced');
			});

			it('setEnvVars onlyIfUnset applies when nothing else set the var', async () => {
				const inst = provider.create(CONTRACT_ID);
				await inst.setEnvVars({ MH_CONTRACT_ENV_UNSET: 'default' }, { onlyIfUnset: true });
				const res = await inst.exec(envProbe('MH_CONTRACT_ENV_UNSET'));
				expect(res.stdout.trim()).toBe('default');
			});
		}
	});
}
