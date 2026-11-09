import type { SandboxFileWrite, SandboxInstance } from '../../ports/sandbox';

/** Preserve adapter method receivers while replacing only the file transport. */
export function withSandboxFileWriter(
	sandbox: SandboxInstance,
	writeFiles: (files: readonly SandboxFileWrite[]) => Promise<void>,
): SandboxInstance {
	return new Proxy(sandbox, {
		get(target, key) {
			if (key === 'writeFiles') return writeFiles;
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}
