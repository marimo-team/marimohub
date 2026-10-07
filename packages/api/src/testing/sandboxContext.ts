import type { SandboxContext } from '@marimo-hub/core';
import type { makeFakeSandbox } from '@marimo-hub/core/testing';

type ContextCalls = Pick<ReturnType<typeof makeFakeSandbox>['calls'], 'exec' | 'writeFile'>;

export function isSandboxContextCommand(command: string): boolean {
	return command.includes('temporary.write_bytes');
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
