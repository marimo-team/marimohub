import { SANDBOX_CONTEXT_COMMAND_MARKER } from '@marimo-hub/core';
import type { SandboxContext, SandboxInstance } from '@marimo-hub/core';
import type { makeFakeSandbox } from '@marimo-hub/core/testing';
import { vi } from 'vitest';

type ContextCalls = Pick<ReturnType<typeof makeFakeSandbox>['calls'], 'exec' | 'writeFile'>;

export function isSandboxContextCommand(command: string): boolean {
	return command.includes(SANDBOX_CONTEXT_COMMAND_MARKER);
}

export function readSandboxContexts(calls: ContextCalls): SandboxContext[] {
	const files = calls.writeFile
		.filter((file) => file.path.startsWith('/tmp/marimohub-context/'))
		.map(({ content }) =>
			typeof content === 'string' ? content : new TextDecoder().decode(content),
		);
	const commands = calls.exec.filter(isSandboxContextCommand).map((command) => {
		const payload = command.match(/'([^']+)'$/)?.[1];
		if (!payload) throw new Error('Sandbox context command is missing its payload');
		return Buffer.from(payload, 'base64url').toString('utf8');
	});
	return [...files, ...commands].map((content) => JSON.parse(content) as SandboxContext);
}

/** Make the subdomain-mode context publication fail; other commands run normally. */
export function failSandboxContextPublication(
	instance: SandboxInstance,
	mode: 'command-failure' | 'command-throw' = 'command-failure',
) {
	const exec = instance.exec.bind(instance);
	return vi.spyOn(instance, 'exec').mockImplementation(async (...args) => {
		if (!isSandboxContextCommand(args[0])) return exec(...args);
		if (mode === 'command-throw') throw new Error('transport unavailable');
		return {
			success: false,
			stdout: '',
			stderr: 'permission denied',
			error: { code: 'COMMAND_FAILED' },
		};
	});
}
