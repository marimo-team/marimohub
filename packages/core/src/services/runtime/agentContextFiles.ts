import { ValidationError } from '../../errors';
import type { SessionRender } from '../../ports/integrations';
import type { SandboxInstance } from '../../ports/sandbox';
import { AGENT_CONTEXT_DIR, assertAgentHomePath } from '../integrations/agentContext';
import { INSTALL_AGENT_CONTEXT } from './agentContextInstall';
import { shellQuote } from './shell';

const INSTALL_ERRORS: Record<string, string> = {
	invalid_home: 'Invalid sandbox home directory.',
	invalid_manifest: 'Invalid previous agent context file list.',
	unsafe_path: 'Agent context paths must not contain symlinks or enter the workspace.',
	root_workspace: 'Agent context requires a workspace directory other than /.',
};

export function agentContextInstallFailureMessage(stdout: string): string {
	const code = stdout.trim();
	return Object.hasOwn(INSTALL_ERRORS, code)
		? INSTALL_ERRORS[code]
		: 'Could not install agent context files.';
}

export async function prepareAgentHomeFiles(
	sandbox: SandboxInstance,
	files: SessionRender['files'],
	workdir: string,
	restored = false,
): Promise<{
	files: { path: string; content: string }[];
	input?: Uint8Array;
	command?: string;
	payloadPath?: string;
	install?: () => Promise<void>;
}> {
	const homeFiles = files.filter((file) => file.relativeTo === 'home');
	if (
		workdir === '/' &&
		files.some(
			(file) => file.relativeTo === 'home' || file.path.startsWith(`${AGENT_CONTEXT_DIR}/`),
		)
	)
		throw new ValidationError(INSTALL_ERRORS.root_workspace);
	if (homeFiles.length === 0 && !restored) return { files };
	for (const file of homeFiles) assertAgentHomePath(file.path);
	const home = homeFiles.length > 0 ? await sandbox.getHomeDirectory?.() : undefined;
	const payload = `/tmp/.marimohub-agent-context-${crypto.randomUUID()}.json`;
	const request = {
		root: sandbox.resolveProcessPath?.('/') ?? '/',
		workdir,
		home,
		files: homeFiles.map(({ path, content }) => ({ path, content })),
		restored,
	};
	const content = JSON.stringify(request);
	const input = new TextEncoder().encode(content);
	const command = `python3 -I -c ${shellQuote(INSTALL_AGENT_CONTEXT)} -`;
	return {
		files: [
			...files.filter((file) => file.relativeTo !== 'home'),
			...(!sandbox.execInput ? [{ path: payload, content }] : []),
		],
		...(!sandbox.execInput ? { payloadPath: payload } : {}),
		input,
		command,
		async install() {
			const options = { timeout: 10_000, maxOutputBytes: 4096 };
			let result;
			if (sandbox.execInput) {
				result = await sandbox.execInput(command, input, options);
			} else {
				const path = shellQuote(sandbox.resolveProcessPath?.(payload) ?? payload);
				result = await sandbox.exec(
					`python3 -I -c ${shellQuote(INSTALL_AGENT_CONTEXT)} ${path}`,
					options,
				);
			}
			if (!result.success)
				throw new ValidationError(agentContextInstallFailureMessage(result.stdout));
		},
	};
}
