import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execResult } from '../ports/sandbox';
import type { ExecResult } from '../ports/sandbox';

/**
 * Environment for Git spawned by tests: the developer's global and system
 * config stay out (`core.fsmonitor`, credential helpers, hooks), and commits
 * need no `user.*` config.
 */
export function hermeticGitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_AUTHOR_NAME: 'Test',
		GIT_AUTHOR_EMAIL: 'test@example.com',
		GIT_COMMITTER_NAME: 'Test',
		GIT_COMMITTER_EMAIL: 'test@example.com',
	};
}

/** Run `git` in `repo` and return its trimmed stdout. */
export function gitInRepo(repo: string, ...args: string[]): string {
	return execFileSync('git', ['-C', repo, ...args], {
		encoding: 'utf8',
		env: hermeticGitEnv(),
	}).trim();
}

/** A `SandboxInstance.exec` that runs the command through the local shell. */
export async function execInLocalShell(
	command: string,
	options: { timeout?: number } = {},
): Promise<ExecResult> {
	const result = spawnSync('/bin/sh', ['-c', command], {
		encoding: 'utf8',
		timeout: options.timeout ?? 20_000,
		maxBuffer: 20 * 1024 * 1024,
		env: hermeticGitEnv(),
	});
	// A timeout or spawn failure reports through `error` with an empty stderr.
	return execResult(
		result.status === 0,
		result.stdout ?? '',
		result.stderr || result.error?.message || '',
	);
}

export interface GitRepoTemplate {
	/** A fresh copy of the template repository in its own temporary directory. */
	instantiate(): string;
	dispose(): void;
}

/**
 * Builds a Git repository once (on first use) and hands out copies of it, so a
 * per-test fixture costs one directory copy rather than a chain of git spawns.
 */
export function createGitRepoTemplate(
	setup: (repo: string, git: (...args: string[]) => string) => void,
	prefix = 'git-template-',
): GitRepoTemplate {
	let template: string | undefined;
	return {
		instantiate() {
			if (!template) {
				// Publish the directory only once setup succeeds, so a failed build is
				// retried rather than copied.
				const building = mkdtempSync(join(tmpdir(), prefix));
				try {
					gitInRepo(building, 'init', '-q');
					setup(building, (...args) => gitInRepo(building, ...args));
				} catch (error) {
					rmSync(building, { recursive: true, force: true });
					throw error;
				}
				template = building;
			}
			const copy = mkdtempSync(join(tmpdir(), prefix));
			cpSync(template, copy, { recursive: true });
			return copy;
		},
		dispose() {
			if (template) rmSync(template, { recursive: true, force: true });
			template = undefined;
		},
	};
}
