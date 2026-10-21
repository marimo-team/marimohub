import { z } from 'zod';
import { ValidationError } from '../../errors';
import { hasControlCharacter } from '../../internal/validation';
import type { SessionRender } from '../../ports/integrations';
import type { SandboxInstance } from '../../ports/sandbox';
import { AGENT_HOME_FILES_MANIFEST, assertAgentHomePath } from '../integrations/agentContext';
import { shellQuote } from './shell';

const MAX_HOME_PATH_BYTES = 4096;
const HomeFilesManifest = z.strictObject({ home: z.string(), paths: z.array(z.string()) });

function homeFilePath(home: string, relative: string, workdir: string): string {
	assertAgentHomePath(relative);
	if (
		!home.startsWith('/') ||
		new TextEncoder().encode(home).byteLength >= MAX_HOME_PATH_BYTES ||
		hasControlCharacter(home) ||
		home.includes('\\') ||
		(home !== '/' &&
			home
				.split('/')
				.slice(1)
				.some((part) => !part || part === '.' || part === '..'))
	)
		throw new ValidationError('Invalid sandbox home directory.');
	const path = `${home === '/' ? '' : home}/${relative}`;
	const workspace = workdir.replace(/\/+$/, '');
	if (path === workspace || path.startsWith(`${workspace}/`)) {
		throw new ValidationError('Agent context files must remain outside the workspace.');
	}
	return path;
}

async function sandboxHome(sandbox: SandboxInstance): Promise<string> {
	let home = '/home/appuser';
	if (sandbox.getHomeDirectory) home = await sandbox.getHomeDirectory();
	else {
		const result = await sandbox.exec('printf \'%s\' "${HOME:-/home/appuser}"', {
			timeout: 10_000,
			maxOutputBytes: MAX_HOME_PATH_BYTES,
		});
		if (
			!result.success ||
			new TextEncoder().encode(result.stdout).byteLength >= MAX_HOME_PATH_BYTES
		)
			throw new ValidationError('Could not determine the sandbox home directory.');
		home = result.stdout || home;
	}
	if (home !== '/') home = home.replace(/\/$/, '');
	return home;
}

export async function resolveAgentHomeFiles(
	sandbox: SandboxInstance,
	files: SessionRender['files'],
	workdir: string,
	restored = false,
): Promise<{ path: string; content: string }[]> {
	const homeFiles = files.filter((file) => file.relativeTo === 'home');
	if (homeFiles.length === 0 && !restored) return files;
	const [home, previous] = await Promise.all([
		homeFiles.length > 0 ? sandboxHome(sandbox) : '/home/appuser',
		restored ? sandbox.readFile(AGENT_HOME_FILES_MANIFEST) : undefined,
	]);
	const resolved = files.map((file) => ({
		path: file.relativeTo === 'home' ? homeFilePath(home, file.path, workdir) : file.path,
		content: file.content,
	}));
	// Full filesystem snapshots retain home files, including skills removed since the last session.
	if (previous) {
		if (previous.success) {
			let manifest: z.infer<typeof HomeFilesManifest>;
			try {
				manifest = HomeFilesManifest.parse(JSON.parse(previous.content));
			} catch {
				throw new ValidationError('Invalid previous agent context file list.');
			}
			const current = new Set(resolved.map((file) => file.path));
			const stale = manifest.paths
				.map((path) => homeFilePath(manifest.home, path, workdir))
				.filter((path) => !current.has(path));
			if (homeFiles.length === 0) stale.push(AGENT_HOME_FILES_MANIFEST);
			if (stale.length > 0) {
				const removed = await sandbox.exec(`rm -f -- ${stale.map(shellQuote).join(' ')}`, {
					timeout: 10_000,
				});
				if (!removed.success)
					throw new ValidationError('Could not remove previous agent context files.');
			}
		} else if (previous.error.code !== 'NOT_FOUND') {
			throw new ValidationError('Could not read the previous agent context file list.');
		}
	}
	if (homeFiles.length > 0)
		resolved.push({
			path: AGENT_HOME_FILES_MANIFEST,
			content: JSON.stringify({ home, paths: homeFiles.map((file) => file.path) }),
		});
	return resolved;
}
