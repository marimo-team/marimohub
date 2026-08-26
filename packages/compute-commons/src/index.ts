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

export const NOT_A_DIRECTORY_MARKER = 'MARIMOHUB_NOT_A_DIRECTORY';
export const NOT_A_DIRECTORY_EXIT_CODE = 20;

export function buildDirectoryProbeCommand(path: string): string {
	const quotedPath = shellQuote(path);
	return `if [ -d ${quotedPath} ]; then :; elif [ -e ${quotedPath} ] || [ -L ${quotedPath} ]; then printf '${NOT_A_DIRECTORY_MARKER}\\n' >&2; exit ${NOT_A_DIRECTORY_EXIT_CODE}; else exit 1; fi`;
}

export function classifyListFilesFailure(output: {
	stdout: string;
	stderr: string;
}): 'NOT_A_DIRECTORY' | 'LIST_FAILED' {
	const hasMarkerLine = (value: string) => value.split(/\r?\n/).includes(NOT_A_DIRECTORY_MARKER);
	return hasMarkerLine(output.stdout) || hasMarkerLine(output.stderr)
		? 'NOT_A_DIRECTORY'
		: 'LIST_FAILED';
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
		"-printf '%y\\t%s\\t%p\\0'",
	];
	return `${buildDirectoryProbeCommand(path)}; ${parts.join(' ')}`;
}

export function parseFindFilesOutput(
	stdout: string,
	rootPath: string,
	options?: Pick<FindFilesOptions, 'includeHidden'>,
): ParsedFileInfo[] {
	const files: ParsedFileInfo[] = [];
	for (const record of stdout.split('\0')) {
		if (!record) continue;
		const [typeChar, sizeStr, ...pathParts] = record.split('\t');
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
	// The connect timeout is clamped to the remaining budget: against a
	// blackholed port (packets dropped, not refused) a fixed 1s timeout could
	// let the final connect run past the deadline.
	const script =
		'import socket,sys,time\n' +
		`end=time.monotonic()+${seconds}\n` +
		'while True:\n' +
		'    left=end-time.monotonic()\n' +
		'    s=socket.socket(); s.settimeout(max(0.01,min(1,left)))\n' +
		`    ok=s.connect_ex(("127.0.0.1",${port}))==0\n` +
		'    s.close()\n' +
		'    if ok: sys.exit(0)\n' +
		'    if time.monotonic()>=end: sys.exit(1)\n' +
		'    time.sleep(0.05)\n';
	return `python3 -c ${shellQuote(script)}`;
}

export type LaunchProtocolFailure =
	| 'setup_exit'
	| 'setup_timeout'
	| 'kernel_exit'
	| 'readiness_timeout';

export interface LaunchProtocolOutcome {
	kind: 'ready' | LaunchProtocolFailure;
	setupMs: number;
	waitportMs: number;
	exitCode?: number;
}

export interface LaunchCommand {
	command: string;
	nonce: string;
}

const LAUNCH_SUPERVISOR = `import json, os, signal, socket, subprocess, sys, time
nonce, timeout_arg, command, setup, port_arg = sys.argv[1:]
timeout = float(timeout_arg) / 1000
port = int(port_arg)
started = time.monotonic()
deadline = None if timeout == 0 else started + timeout
prefix = "__MARIMOHUB_LAUNCH_" + nonce + "__"
current = None

def elapsed(since):
    return max(0, round((time.monotonic() - since) * 1000))

def emit(event, **values):
    print(prefix + json.dumps({"event": event, **values}, separators=(",", ":")), file=sys.stderr, flush=True)

def remaining():
    return None if deadline is None else max(0, deadline - time.monotonic())

def stop_process(process, sig=signal.SIGTERM):
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        return

def forward(sig, _frame):
    stop_process(current, sig)

for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, forward)

setup_started = time.monotonic()
if setup:
    current = subprocess.Popen(["sh", "-lc", setup], start_new_session=True)
    try:
        setup_code = current.wait(timeout=remaining())
    except subprocess.TimeoutExpired:
        stop_process(current, signal.SIGKILL)
        current.wait()
        emit("setup_timeout", setupMs=elapsed(setup_started), waitportMs=0)
        sys.exit(124)
    if setup_code != 0:
        emit("setup_exit", setupMs=elapsed(setup_started), waitportMs=0, exitCode=setup_code)
        sys.exit(setup_code)
setup_ms = elapsed(setup_started)
emit("setup_complete", setupMs=setup_ms, waitportMs=0)

kernel_started = time.monotonic()
current = subprocess.Popen(["sh", "-lc", command], start_new_session=True)
while True:
    kernel_code = current.poll()
    if kernel_code is not None:
        emit("kernel_exit", setupMs=setup_ms, waitportMs=elapsed(kernel_started), exitCode=kernel_code)
        sys.exit(kernel_code or 1)
    probe = socket.socket()
    probe.settimeout(0.2)
    try:
        ready = probe.connect_ex(("127.0.0.1", port)) == 0
    finally:
        probe.close()
    if ready:
        emit("ready", setupMs=setup_ms, waitportMs=elapsed(kernel_started))
        sys.exit(current.wait())
    if deadline is not None and time.monotonic() >= deadline:
        emit("readiness_timeout", setupMs=setup_ms, waitportMs=elapsed(kernel_started))
        stop_process(current, signal.SIGTERM)
        try:
            current.wait(timeout=2)
        except subprocess.TimeoutExpired:
            stop_process(current, signal.SIGKILL)
            current.wait()
        sys.exit(124)
    time.sleep(0.05)`;

export function buildLaunchCommand(options: {
	setup?: string;
	command: string;
	port: number;
	startupTimeout: number;
	nonce?: string;
}): LaunchCommand {
	const nonce = options.nonce ?? crypto.randomUUID().replaceAll('-', '');
	const args = [
		nonce,
		String(options.startupTimeout),
		options.command,
		options.setup ?? '',
		String(options.port),
	].map(shellQuote);
	return {
		nonce,
		command: `exec python3 -c ${shellQuote(LAUNCH_SUPERVISOR)} ${args.join(' ')}`,
	};
}

/**
 * Parse one output line (trailing newline stripped) for a supervisor marker.
 * Markers can appear mid-line after unterminated kernel output, so the match is
 * an `indexOf`, not a prefix check. Returns `undefined` when the line carries no
 * valid marker payload; otherwise the marker's event, the text preceding it, and
 * the structured outcome when the event is terminal.
 */
function parseMarkerLine(
	line: string,
	marker: string,
): { before: string; event?: string; outcome?: LaunchProtocolOutcome } | undefined {
	const index = line.indexOf(marker);
	if (index === -1) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.slice(index + marker.length));
	} catch {
		return undefined;
	}
	// A marker followed by a non-object payload (`null`, a scalar, an array) is
	// not a supervisor event — keep it as ordinary output instead of throwing.
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
	const value = parsed as {
		event?: string;
		setupMs?: number;
		waitportMs?: number;
		exitCode?: number;
	};
	const event = value.event;
	const outcome: LaunchProtocolOutcome | undefined =
		event === 'ready' ||
		event === 'setup_exit' ||
		event === 'setup_timeout' ||
		event === 'kernel_exit' ||
		event === 'readiness_timeout'
			? {
					kind: event,
					setupMs: Math.max(0, value.setupMs ?? 0),
					waitportMs: Math.max(0, value.waitportMs ?? 0),
					...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
				}
			: undefined;
	return { before: line.slice(0, index), event, ...(outcome ? { outcome } : {}) };
}

function parseProtocolText(
	text: string,
	nonce: string,
): {
	text: string;
	events: LaunchProtocolOutcome[];
} {
	const marker = `__MARIMOHUB_LAUNCH_${nonce}__`;
	const events: LaunchProtocolOutcome[] = [];
	const kept: string[] = [];
	for (const line of text.split(/(?<=\n)/)) {
		const parsed = parseMarkerLine(line.replace(/\r?\n$/, ''), marker);
		if (!parsed) {
			kept.push(line);
			continue;
		}
		if (parsed.outcome) events.push(parsed.outcome);
		if (parsed.before) kept.push(parsed.before);
	}
	return { text: kept.join(''), events };
}

export function parseLaunchOutput(
	logs: { stdout: string; stderr: string },
	nonce: string,
): { stdout: string; stderr: string; outcome?: LaunchProtocolOutcome } {
	const stdout = parseProtocolText(logs.stdout, nonce);
	const stderr = parseProtocolText(logs.stderr, nonce);
	return {
		stdout: stdout.text,
		stderr: stderr.text,
		outcome: [...stdout.events, ...stderr.events].at(-1),
	};
}

/**
 * How long after the startup deadline a terminal launch marker may still arrive
 * over the adapter's log/stream channel before the launch is classified locally.
 * Generous on purpose: it is only paid on timeout paths, and a too-short grace
 * risks misclassifying a completed setup as `setup_timeout`.
 */
export const LAUNCH_MARKER_GRACE_MS = 250;

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The sniff string proving the supervisor finished setup — checked on timeout
 * paths to distinguish `setup_timeout` from `readiness_timeout` even when the
 * marker line is interleaved with other output.
 */
export function setupCompleteMarker(nonce: string): string {
	return `__MARIMOHUB_LAUNCH_${nonce}__{"event":"setup_complete"`;
}

/**
 * Cap on the tracker's per-stream carry of an unterminated line. A supervisor
 * marker line is ~200 bytes, so any marker straddling a chunk boundary lies
 * within the trailing 1 KiB — kernel garbage without newlines must not grow the
 * carry unboundedly.
 */
const TRACKER_CARRY_MAX_CHARS = 1024;

/**
 * Latches launch-protocol state from RAW output chunks, before any truncation.
 * Adapters that retain only a capped {@link OutputTail} of kernel output must
 * derive `setupCompleted`/`outcome` from this instead of re-scanning the tail:
 * a marker can be evicted from the tail by later output, misclassifying (e.g.)
 * a `readiness_timeout` as `setup_timeout`. O(1) memory — only the latched
 * state and a small per-stream carry for lines split across chunks.
 */
export class LaunchProtocolTracker {
	private readonly marker: string;
	private readonly carries = { stdout: '', stderr: '' };
	private lastOutcome: LaunchProtocolOutcome | undefined;
	private setupSeen = false;

	constructor(nonce: string) {
		this.marker = `__MARIMOHUB_LAUNCH_${nonce}__`;
	}

	feed(stream: 'stdout' | 'stderr', chunk: string): void {
		const text = this.carries[stream] + chunk;
		// The supervisor always terminates a marker line with a newline, so only
		// complete lines are scanned; the unterminated remainder is carried.
		const lastNewline = text.lastIndexOf('\n');
		if (lastNewline !== -1) {
			for (const line of text.slice(0, lastNewline).split('\n')) {
				const parsed = parseMarkerLine(line.replace(/\r$/, ''), this.marker);
				if (!parsed) continue;
				if (parsed.event === 'setup_complete') this.setupSeen = true;
				if (parsed.outcome) this.lastOutcome = parsed.outcome;
			}
		}
		const carry = lastNewline === -1 ? text : text.slice(lastNewline + 1);
		this.carries[stream] = carry.slice(-TRACKER_CARRY_MAX_CHARS);
	}

	/** Last terminal event seen (last one wins, matching {@link parseLaunchOutput}). */
	get outcome(): LaunchProtocolOutcome | undefined {
		return this.lastOutcome;
	}

	/** Latched once a `setup_complete` marker is seen. */
	get setupCompleted(): boolean {
		return this.setupSeen;
	}
}

export interface LaunchTimings {
	setup: number;
	start: number;
	waitport: number;
}

/** The failure arm of the port's `SandboxLaunchResult` (structurally compatible). */
export interface LaunchFailureResult {
	success: false;
	reason: LaunchProtocolFailure | 'transport_failure';
	exitCode?: number;
	stdout: string;
	stderr: string;
	timings: LaunchTimings;
}

/** Launch failed before/outside the supervised protocol: no output, only the error. */
export function transportFailureResult(err: unknown, timings: LaunchTimings): LaunchFailureResult {
	return {
		success: false,
		reason: 'transport_failure',
		stdout: '',
		stderr: errorMessage(err),
		timings,
	};
}

/** Map a terminal (non-`ready`) supervisor outcome onto the launch-result envelope. */
export function launchOutcomeResult(
	kind: LaunchProtocolFailure,
	outcome: Pick<LaunchProtocolOutcome, 'setupMs' | 'waitportMs' | 'exitCode'>,
	output: { stdout: string; stderr: string },
	start: number,
): LaunchFailureResult {
	return {
		success: false,
		reason: kind,
		...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
		stdout: output.stdout,
		stderr: output.stderr,
		timings: { setup: outcome.setupMs, start, waitport: outcome.waitportMs },
	};
}

/**
 * The deadline passed with no terminal marker: blame setup if one was requested
 * and never completed (charging it the whole remaining budget), else readiness.
 */
export function launchTimeoutResult(options: {
	setup: boolean;
	setupCompleted: boolean;
	startupTimeout: number;
	output: { stdout: string; stderr: string };
	start: number;
	waitport: number;
}): LaunchFailureResult {
	const reason = options.setup && !options.setupCompleted ? 'setup_timeout' : 'readiness_timeout';
	return {
		success: false,
		reason,
		stdout: options.output.stdout,
		stderr: options.output.stderr,
		timings: {
			setup: reason === 'setup_timeout' ? Math.max(0, options.startupTimeout - options.start) : 0,
			start: options.start,
			waitport: options.waitport,
		},
	};
}

/** Default cap for retained kernel output — these buffers exist for error reporting only. */
export const LAUNCH_OUTPUT_TAIL_BYTES = 64 * 1024;

/**
 * Capped accumulator keeping only the trailing `maxBytes` (UTF-8, cut on a
 * character boundary) of appended text. Adapters that pump a kernel's live
 * stdout/stderr into strings use this so retained output stays bounded for the
 * sandbox's whole lifetime instead of growing with every chunk.
 */
export class OutputTail {
	private value = '';

	constructor(private readonly maxBytes: number = LAUNCH_OUTPUT_TAIL_BYTES) {}

	append(chunk: string): void {
		this.value += chunk;
		// UTF-8 emits at most 3 bytes per UTF-16 code unit, so a short value
		// cannot exceed the cap — skip the encode until that guarantee is gone.
		if (this.value.length * 3 <= this.maxBytes) return;
		const encoded = new TextEncoder().encode(this.value);
		if (encoded.byteLength <= this.maxBytes) return;
		let start = encoded.byteLength - this.maxBytes;
		while ((encoded[start] & 0xc0) === 0x80) start++;
		this.value = new TextDecoder().decode(encoded.subarray(start));
	}

	get text(): string {
		return this.value;
	}
}

export interface LaunchableProcess {
	waitForPort(
		port: number,
		options?: { timeout?: number; mode?: 'http' | 'tcp'; path?: string },
	): Promise<void>;
	getLogs(): Promise<{ stdout: string; stderr: string }>;
}

export type ProcessLaunchResult<P extends LaunchableProcess> =
	| {
			success: true;
			process: P;
			timings: LaunchTimings;
	  }
	| LaunchFailureResult;

/**
 * Compatibility implementation for process APIs that expose readiness and logs
 * but not their live output stream. The setup and kernel still share one remote
 * command; the native waiter observes the same port as the supervisor.
 */
export async function launchWithProcess<P extends LaunchableProcess>(options: {
	setup?: string;
	command: string;
	port: number;
	startupTimeout: number;
	waitForPort?: { mode?: 'http' | 'tcp'; path?: string };
	start(command: string): Promise<P>;
	now?: () => number;
}): Promise<ProcessLaunchResult<P>> {
	const now = options.now ?? Date.now;
	const built = buildLaunchCommand(options);
	const launchStarted = now();
	let process: P;
	try {
		process = await options.start(built.command);
	} catch (error) {
		return transportFailureResult(error, {
			setup: 0,
			start: Math.max(0, now() - launchStarted),
			waitport: 0,
		});
	}
	const start = now() - launchStarted;
	const waitStarted = now();
	const remaining =
		options.startupTimeout === 0
			? Number.POSITIVE_INFINITY
			: Math.max(0, options.startupTimeout - (now() - launchStarted));
	try {
		await process.waitForPort(options.port, {
			...options.waitForPort,
			timeout: remaining,
		});
	} catch (error) {
		if (options.startupTimeout !== 0 && now() - launchStarted >= options.startupTimeout) {
			await sleep(75);
		}
		let parsed: ReturnType<typeof parseLaunchOutput>;
		let setupCompleted = false;
		try {
			const logs = await process.getLogs();
			setupCompleted = `${logs.stdout}\n${logs.stderr}`.includes(setupCompleteMarker(built.nonce));
			parsed = parseLaunchOutput(logs, built.nonce);
		} catch (logError) {
			return transportFailureResult(logError, {
				setup: 0,
				start,
				waitport: Math.max(0, now() - waitStarted),
			});
		}
		const outcome = parsed.outcome;
		if (outcome && outcome.kind !== 'ready') {
			return launchOutcomeResult(outcome.kind, outcome, parsed, start);
		}
		const deadlineExpired =
			options.startupTimeout !== 0 && now() - launchStarted >= options.startupTimeout;
		const reason =
			options.setup && deadlineExpired && !setupCompleted
				? 'setup_timeout'
				: /before port \d+/.test(error instanceof Error ? error.message.split('\n', 1)[0] : '')
					? 'kernel_exit'
					: 'readiness_timeout';
		return {
			success: false,
			reason,
			...(outcome?.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
			stdout: parsed.stdout,
			stderr: parsed.stderr,
			timings: {
				setup:
					outcome?.setupMs ??
					(reason === 'setup_timeout' ? Math.max(0, options.startupTimeout - start) : 0),
				start,
				waitport: outcome?.waitportMs ?? now() - waitStarted,
			},
		};
	}
	let parsed: ReturnType<typeof parseLaunchOutput>;
	try {
		parsed = parseLaunchOutput(await process.getLogs(), built.nonce);
	} catch (error) {
		return transportFailureResult(error, {
			setup: 0,
			start,
			waitport: Math.max(0, now() - waitStarted),
		});
	}
	return {
		success: true,
		process,
		timings: {
			setup: parsed.outcome?.setupMs ?? 0,
			start,
			waitport: parsed.outcome?.waitportMs ?? now() - waitStarted,
		},
	};
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
