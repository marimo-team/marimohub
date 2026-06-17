/**
 * @marimo-hub/compute-commons — vendor-free helpers shared by the compute
 * adapters (`compute-local`, `compute-coreweave`, …).
 *
 * These are infrastructure utilities, NOT domain logic, so they live here rather
 * than in `@marimo-hub/core` (which stays pure-domain). The package depends on no
 * vendor SDK and no `core` port, so any adapter can use it without widening its
 * dependency surface.
 */

// Private duplicate of core's `duration.ts` sleep: this package is
// intentionally zero-dep (no `core` import), so it keeps its own copy.
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single-quote a value for safe interpolation into a `sh -lc` / `sh -c` string.
 * Wraps the value in single quotes and escapes any embedded single quote as the
 * classic `'\''` sequence, so the result is injection-safe for arbitrary input
 * (paths, repo URLs, env values, …).
 *
 * @example shellQuote("a'b") // => "'a'\\''b'"
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the `export K='v'; …` shell prefix that carries accumulated env vars into
 * a command, for backends whose `exec` has no per-command env (CoreWeave, Docker,
 * Kubernetes pod-exec). Values are {@link shellQuote}d. Returns `cmd` unchanged
 * when `env` is empty.
 */
export function withEnvPrefix(cmd: string, env: Record<string, string>): string {
	const keys = Object.keys(env);
	if (keys.length === 0) return cmd;
	const prefix = keys.map((k) => `export ${k}=${shellQuote(env[k])}; `).join('');
	return prefix + cmd;
}

export interface GitCloneOptions {
	/** Branch to check out (`--branch <branch>`). */
	branch?: string;
	/** Target directory for the clone. Defaults to `.`. */
	targetDir?: string;
}

/**
 * Build a shell-safe `git clone` command string. The repo, branch, and target
 * are {@link shellQuote}d, closing the command-injection hole that hand-rolled
 * `git clone ${repo}` interpolation leaves open. Returns a single `sh -c`-ready
 * string.
 *
 * @example buildGitCloneCommand('https://x/y', { branch: 'main', targetDir: 'w' })
 *   // => "git clone --branch 'main' 'https://x/y' 'w'"
 */
export function buildGitCloneCommand(repo: string, options?: GitCloneOptions): string {
	const target = options?.targetDir ?? '.';
	const parts = ['git', 'clone'];
	if (options?.branch) parts.push('--branch', shellQuote(options.branch));
	parts.push(shellQuote(repo), shellQuote(target));
	return parts.join(' ');
}

/**
 * Adapt an `AsyncIterable<string>` (e.g. an SDK's streamed command output) to a
 * web `ReadableStream` of UTF-8 bytes. Pulls lazily, closes when the iterable is
 * exhausted, forwards errors to the stream, and calls the iterator's `return()`
 * on cancel so the upstream can clean up.
 */
export function iterableToStream(iterable: AsyncIterable<string>): ReadableStream {
	const iterator = iterable[Symbol.asyncIterator]();
	const encoder = new TextEncoder();
	return new ReadableStream({
		async pull(controller) {
			try {
				const { value, done } = await iterator.next();
				if (done) {
					controller.close();
				} else {
					controller.enqueue(encoder.encode(value));
				}
			} catch (err) {
				controller.error(err);
			}
		},
		async cancel() {
			await iterator.return?.();
		},
	});
}

export interface PollOptions {
	/** Give up after this many ms. Default 30000. */
	timeoutMs?: number;
	/** Delay between probe attempts, in ms. Default 250. */
	intervalMs?: number;
	/**
	 * Build the Error message thrown on timeout. May be async so callers can fetch
	 * diagnostics (e.g. tail the process log) only when the wait actually fails.
	 * Defaults to a generic message.
	 */
	timeoutMessage?: () => string | Promise<string>;
}

/**
 * Poll `probe()` until it resolves truthy or the deadline passes. Used by the
 * adapters' `waitForPort` (a TCP-connect probe locally; an in-sandbox probe over
 * `exec` on CoreWeave) to share one deadline loop.
 *
 * If `probe()` itself THROWS, the error propagates immediately (no retry) — this
 * is how a caller signals an unrecoverable condition mid-wait, e.g. "the process
 * exited before the port opened". On deadline, throws `timeoutMessage()` (or a
 * generic message).
 */
export async function pollUntilReady(
	probe: () => boolean | Promise<boolean>,
	options?: PollOptions,
): Promise<void> {
	const timeoutMs = options?.timeoutMs ?? 30_000;
	const intervalMs = options?.intervalMs ?? 250;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await probe()) return;
		await sleep(intervalMs);
	}
	throw new Error((await options?.timeoutMessage?.()) ?? `timed out after ${timeoutMs}ms`);
}
