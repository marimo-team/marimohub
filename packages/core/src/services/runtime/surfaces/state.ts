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
 * KILL after 5 s) and removes the PID file. Exits non-zero when the process
 * survives so callers never mark a live editor as stopped.
 */
export function stopSurfaceProcessCommand(
	pidFile: string,
	options: StopSurfaceProcessOptions = {},
): string {
	const stop = `if test ! -f ${shellQuote(pidFile)}; then ${options.requirePid ? 'exit 1' : 'exit 0'}; fi; pid="$(cat ${shellQuote(pidFile)})"; case "$pid" in ''|*[!0-9]*) exit 1;; esac; kill -TERM "$pid" 2>/dev/null || true; i=0; while kill -0 "$pid" 2>/dev/null && test "$i" -lt 10; do sleep 0.5; i=$((i+1)); done; kill -KILL "$pid" 2>/dev/null || true; sleep 0.1; kill -0 "$pid" 2>/dev/null && exit 1; rm -f ${shellQuote(pidFile)}`;
	if (!options.cancelFile) return stop;
	const dir = pidFile.slice(0, pidFile.lastIndexOf('/'));
	return `mkdir -p ${shellQuote(dir)} && touch ${shellQuote(options.cancelFile)} && { ${stop}; }`;
}
