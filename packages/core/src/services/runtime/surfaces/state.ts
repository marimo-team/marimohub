import { shellQuote } from '../shell';
import type { SurfaceId } from './types';

/**
 * Per-session, per-surface scratch root inside the sandbox. Holds the editor's
 * user-data directory, its PID file and start-cancellation markers. Lives
 * outside the workspace so it is never captured or versioned.
 */
export const SURFACE_STATE_ROOT = '/tmp/.marimohub/surfaces';

export function surfaceStateDir(sessionId: string, surface: SurfaceId): string {
	return `${SURFACE_STATE_ROOT}/${sessionId}/${surface}`;
}

/**
 * Holds one line, `<pid> <identity>`, where identity is the process start time
 * (see `PROCESS_IDENTITY_FN`). A PID alone is not enough: an editor that exits
 * on its own leaves the file behind, and the kernel may hand its PID to an
 * unrelated process before the next stop runs.
 */
export function surfacePidFile(sessionId: string, surface: SurfaceId): string {
	return `${surfaceStateDir(sessionId, surface)}/surface.pid`;
}

export function surfaceCancelFile(
	sessionId: string,
	surface: SurfaceId,
	attemptId: string,
): string {
	return `${surfaceStateDir(sessionId, surface)}/cancel-${attemptId}`;
}

/**
 * POSIX `sh` function printing a cheap identity for PID `$1`: the kernel start
 * time from `/proc/<pid>/stat` field 22 (stripped past the `(comm)` field, which
 * may contain spaces, so it lands at position 20), or `ps -o lstart` where there
 * is no procfs (local compute on macOS). Both survive `exec`, so the value the
 * launcher records for `$$` still matches once the editor has replaced the
 * shell. Prints nothing for a PID that is not running.
 */
const PROCESS_IDENTITY_FN = `mh_ident() { if test -r "/proc/$1/stat"; then sed 's/^.*) //' "/proc/$1/stat" | cut -d' ' -f20; else ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//'; fi; }`;

/** Reads `pid` and `want` from the PID file; exits 1 when the PID is malformed. */
function readPidFile(pidFile: string): string {
	return `read -r pid want < ${shellQuote(pidFile)}; case "$pid" in ''|*[!0-9]*) exit 1;; esac`;
}

/** True only when `pid` is alive and is still the process the launcher recorded. */
const RECORDED_PROCESS_ALIVE = `kill -0 "$pid" 2>/dev/null && test "$(mh_ident "$pid")" = "$want"`;

/**
 * Shell command wrapping a surface launch: records the launcher's PID and
 * identity, then `exec`s the editor so the recorded PID stays valid. The
 * cancellation marker is checked on both sides of the PID write, so a stop that
 * races the launch either finds the PID file or is seen by the launcher; a
 * launcher that backs out removes the marker (and its own PID file) since no
 * other process will ever read them.
 */
export function launchSurfaceProcessCommand(
	pidFile: string,
	cancelFile: string,
	command: string,
): string {
	const dir = pidFile.slice(0, pidFile.lastIndexOf('/'));
	const cancelled = `if test -f ${shellQuote(cancelFile)}; then rm -f ${shellQuote(cancelFile)}`;
	return `mkdir -p ${shellQuote(dir)} || exit 1; ${PROCESS_IDENTITY_FN}; ${cancelled}; exit 1; fi; printf '%s %s\\n' "$$" "$(mh_ident $$)" > ${shellQuote(pidFile)}; ${cancelled}; read -r pid want < ${shellQuote(pidFile)}; test "$pid" = "$$" && rm -f ${shellQuote(pidFile)}; exit 1; fi; exec ${command}`;
}

/** Shell command exiting 0 only when the recorded surface process is still running. */
export function surfaceProcessAliveCommand(pidFile: string): string {
	return `test -f ${shellQuote(pidFile)} || exit 1; ${PROCESS_IDENTITY_FN}; ${readPidFile(pidFile)}; ${RECORDED_PROCESS_ALIVE}`;
}

export interface StopSurfaceProcessOptions {
	/** Fail when no PID file exists (a `ready` surface must have one). */
	requirePid?: boolean;
	/**
	 * Cancellation marker to drop before killing: a launch that has not yet
	 * written its PID file checks for it and refuses to exec.
	 */
	cancelFile?: string;
}

/**
 * Shell script that terminates the process recorded in `pidFile` (TERM, then
 * KILL after 5 s), removes the PID file and sweeps stale cancellation markers.
 * Exits non-zero when the process survives so callers never mark a live editor
 * as stopped. A PID whose identity no longer matches the record belongs to an
 * unrelated process (the editor exited and the PID was reused): it is left
 * alone and only the stale PID file is removed.
 *
 * The marker written for `cancelFile` is deliberately kept: the launch it
 * targets may not have run yet. Markers from earlier attempts are swept, since
 * their launches have long since been decided.
 */
export function stopSurfaceProcessCommand(
	pidFile: string,
	options: StopSurfaceProcessOptions = {},
): string {
	const dir = pidFile.slice(0, pidFile.lastIndexOf('/'));
	const kill = `if ${RECORDED_PROCESS_ALIVE}; then kill -TERM "$pid" 2>/dev/null || true; i=0; while kill -0 "$pid" 2>/dev/null && test "$i" -lt 10; do sleep 0.5; i=$((i+1)); done; kill -KILL "$pid" 2>/dev/null || true; sleep 0.1; kill -0 "$pid" 2>/dev/null && exit 1; fi`;
	const sweep = options.cancelFile
		? `for f in ${shellQuote(dir)}/cancel-*; do test "$f" = ${shellQuote(options.cancelFile)} || rm -f "$f"; done`
		: `rm -f ${shellQuote(dir)}/cancel-*`;
	const stop = `${PROCESS_IDENTITY_FN}; if test -f ${shellQuote(pidFile)}; then ${readPidFile(pidFile)}; ${kill}; rm -f ${shellQuote(pidFile)}; ${options.requirePid ? 'else exit 1; ' : ''}fi; ${sweep}`;
	if (!options.cancelFile) return stop;
	return `mkdir -p ${shellQuote(dir)} && touch ${shellQuote(options.cancelFile)} && { ${stop}; }`;
}
