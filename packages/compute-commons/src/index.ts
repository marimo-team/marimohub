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
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
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
 * a command, for backends whose `exec` has no per-command env (CoreWeave,
 * Docker, Podman, Kubernetes pod-exec). Values are {@link shellQuote}d. Returns
 * `cmd` unchanged when `env` and `defaults` are empty.
 *
 * `defaults` are fallbacks (`setEnvVars` with `onlyIfUnset`): each is exported
 * behind a `[ -n "${K:-}" ]` guard, so a value the sandbox already defines —
 * image ENV, profile script, or a forced export from `env` — wins. The guards
 * come after the forced exports, which is what lets a key present in both
 * resolve to the forced value.
 */
export function withEnvPrefix(
	cmd: string,
	env: Record<string, string>,
	defaults: Record<string, string> = {},
): string {
	const forced = Object.keys(env).map((k) => `export ${k}=${shellQuote(env[k])}; `);
	const guarded = Object.keys(defaults).map(
		(k) => `[ -n "\${${k}:-}" ] || export ${k}=${shellQuote(defaults[k])}; `,
	);
	return forced.join('') + guarded.join('') + cmd;
}

/**
 * Drop `undefined` values so optional config can be collected in one literal
 * instead of a per-key conditional-spread chain (`...(x ? { k: x } : {})`).
 */
export function removeUndefined<V>(
	obj: Readonly<Record<string, V | undefined>>,
): Record<string, V> {
	return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Record<
		string,
		V
	>;
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

export interface FindFilesOptions {
	recursive?: boolean;
	includeHidden?: boolean;
}

export interface ParsedFileInfo {
	name: string;
	absolutePath: string;
	relativePath: string;
	type: 'file' | 'directory' | 'symlink' | 'other';
	size: number;
}

export function buildFindFilesCommand(
	path: string,
	options?: Pick<FindFilesOptions, 'recursive'>,
): string {
	const parts = [
		'find',
		shellQuote(path),
		'-mindepth 1',
		...(options?.recursive ? [] : ['-maxdepth 1']),
		"-printf '%y\\t%s\\t%p\\n'",
	];
	return parts.join(' ');
}

export function parseFindFilesOutput(
	stdout: string,
	rootPath: string,
	options?: Pick<FindFilesOptions, 'includeHidden'>,
): ParsedFileInfo[] {
	const files: ParsedFileInfo[] = [];
	for (const line of stdout.split('\n')) {
		if (!line) continue;
		const [typeChar, sizeStr, ...pathParts] = line.split('\t');
		const absolutePath = pathParts.join('\t');
		if (!absolutePath) continue;
		const name = absolutePath.slice(absolutePath.lastIndexOf('/') + 1);
		if (!options?.includeHidden && name.startsWith('.')) continue;
		files.push({
			name,
			absolutePath,
			relativePath: absolutePath.startsWith(rootPath)
				? absolutePath.slice(rootPath.length).replace(/^\//, '')
				: absolutePath,
			type:
				typeChar === 'f'
					? 'file'
					: typeChar === 'd'
						? 'directory'
						: typeChar === 'l'
							? 'symlink'
							: 'other',
			size: Number(sizeStr) || 0,
		});
	}
	return files;
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

/**
 * Shell command that blocks until `port` accepts a connection, for at most
 * `seconds` (fractions allowed). Exits 0 as soon as it does, 1 on its own
 * deadline. Adapters whose only probe channel is a per-command round-trip
 * (CoreWeave exec, k8s Pod exec) run this IN-SANDBOX so the wait isn't
 * quantized to the round-trip + poll interval. The whole loop runs inside one
 * `python3` on a `time.monotonic()` deadline — millisecond-accurate, where a
 * shell `date +%s` loop truncates to whole seconds and can end a chunk almost
 * a second early. Always probes at least once. Assumes `python3` on the
 * sandbox image's PATH.
 */
export function portWaitCommand(port: number, seconds: number): string {
	const script =
		'import socket,sys,time\n' +
		`end=time.monotonic()+${seconds}\n` +
		'while True:\n' +
		'    s=socket.socket(); s.settimeout(1)\n' +
		`    if s.connect_ex(("127.0.0.1",${port}))==0: sys.exit(0)\n` +
		'    s.close()\n' +
		'    if time.monotonic()>=end: sys.exit(1)\n' +
		'    time.sleep(0.05)\n';
	return `python3 -c ${shellQuote(script)}`;
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

/**
 * Run `fn` over `items` with at most `concurrency` in flight. Adapters whose
 * backend has no multi-file write loop their `writeFiles` through this: a bare
 * `Promise.all` over a large set would fire one exec/request per file at once and
 * flood the backend.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = Array.from({ length: items.length });
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]);
		}
	};
	// Floor the pool at 1 so a caller passing 0, a negative, or NaN still drains
	// every item serially rather than silently processing nothing — every adapter's
	// writeFiles rides this, and a no-op there would drop files with no error.
	const requested = Number.isNaN(concurrency) ? 1 : concurrency;
	const pool = Math.max(1, Math.min(requested, items.length));
	await Promise.all(Array.from({ length: pool }, worker));
	return results;
}

/** Max writes in flight when an adapter has to loop per file. */
export const WRITE_CONCURRENCY = 8;

/**
 * Base64-armor raw bytes for a backend whose write channel carries only text —
 * Modal (a JSON body, which would silently stringify a Uint8Array into an index
 * map) and Cloudflare (`encoding: 'base64'`). `btoa` keeps this Workers-safe (no
 * Node `Buffer`); chunked so a large payload can't exceed the argument limit of a
 * spread `String.fromCharCode`.
 */
export function base64Encode(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
