/**
 * Shared structural contract for any `SandboxProvider`.
 *
 * Compute adapters are translation layers: each maps the port onto a backend
 * SDK/HTTP/CLI and is mostly tested by asserting the calls it emits against a
 * backend-shaped fake. So unlike `bucketContract` (which verifies CAS behavior
 * against a faithful store), this contract pins only the fake-agnostic
 * invariants every adapter must honor regardless of backend — a fresh instance
 * exposes the full method surface, `exec` returns a well-formed `ExecResult`,
 * `exposePort` yields a parseable URL, `proxy` never throws, and `destroy`
 * resolves. Behavioral round-trips (writeFile/readFile, exit-code mapping,
 * lifecycle polling) stay in each adapter's own suite, where the fake models
 * that backend.
 *
 * Imports `vitest` — only invoke from a `*.test.ts`. Exposed at the
 * `@marimo-hub/core/testing/compute-contract` subpath so it never reaches runtime.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { SandboxId } from '../ids';
import type { SandboxInstance, SandboxProvider } from '../ports/sandbox';

const CONTRACT_ID = 'sb-aaaaaaaaaaaaaaaa' as SandboxId;

const REQUIRED_METHODS: (keyof SandboxInstance)[] = [
	'exec',
	'execStream',
	'readFile',
	'listFiles',
	'writeFile',
	'gitCheckout',
	'setEnvVars',
	'mountBucket',
	'unmountBucket',
	'startProcess',
	'exposePort',
	'destroy',
];

export interface ComputeContractOptions {
	/**
	 * The adapter rejects `mountBucket` so the provisioner falls back to copying
	 * files in — true for every backend that can't mount the storage bucket
	 * natively (Modal, E2B, Docker, CoreWeave, Kubernetes).
	 */
	mountFallsBack?: boolean;
	/** Hostname passed to `exposePort`; some adapters embed it in the URL. */
	hostname?: string;
}

export function computeContract(
	name: string,
	makeProvider: () => SandboxProvider | Promise<SandboxProvider>,
	opts: ComputeContractOptions = {},
): void {
	const hostname = opts.hostname ?? 'hub.example.com';

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

		it('exec returns a well-formed ExecResult', async () => {
			const res = await provider.create(CONTRACT_ID).exec('true');
			expect(typeof res.success).toBe('boolean');
			expect(typeof res.stdout).toBe('string');
			expect(typeof res.stderr).toBe('string');
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
		}
	});
}
