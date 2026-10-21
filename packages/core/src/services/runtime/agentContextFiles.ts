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

export async function prepareAgentHomeFiles(
	sandbox: SandboxInstance,
	files: SessionRender['files'],
	workdir: string,
	restored = false,
): Promise<{ files: { path: string; content: string }[]; install?: () => Promise<void> }> {
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
	// Local compute rewrites literal sandbox paths in command text, but these must stay logical.
	const argument =
		homeFiles.length > 0
			? shellQuote(sandbox.resolveProcessPath?.(payload) ?? payload)
			: `--inline ${shellQuote(content.replaceAll('/', '\\u002f'))}`;
	return {
		files: [
			...files.filter((file) => file.relativeTo !== 'home'),
			...(homeFiles.length > 0 ? [{ path: payload, content }] : []),
		],
		async install() {
			// Discover HOME and install through no-follow directory handles in the same request.
			const result = await sandbox.exec(
				`python3 -I -c ${shellQuote(INSTALL_AGENT_CONTEXT)} ${argument}`,
				{ timeout: 10_000, maxOutputBytes: 4096 },
			);
			if (!result.success)
				throw new ValidationError(
					Object.hasOwn(INSTALL_ERRORS, result.stdout.trim())
						? INSTALL_ERRORS[result.stdout.trim()]
						: 'Could not install agent context files.',
				);
		},
	};
}
