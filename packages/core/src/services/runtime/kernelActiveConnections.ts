import { MARIMO_PORT } from '../../constants';
import { NotFoundError } from '../../errors';
import type { SandboxInstance } from '../../ports/sandbox';
import { KERNEL_AUTH_TOKEN_FILE } from './kernelAuth';
import { shellQuote } from './shell';

/**
 * Probe the kernel through its configured base path, using its token when present.
 * An unreachable kernel or invalid response returns null (unknown), never idle.
 * A `NotFoundError` (the sandbox itself is gone) propagates: that is a definite
 * answer the caller must act on, not an unknown.
 */
export async function kernelActiveConnections(
	sandbox: SandboxInstance,
	basePath = '',
): Promise<number | null> {
	try {
		const url = `http://127.0.0.1:${MARIMO_PORT}${basePath}/api/status/connections`;
		const script =
			'import json,pathlib,urllib.request;' +
			`p=pathlib.Path(${JSON.stringify(KERNEL_AUTH_TOKEN_FILE)});` +
			'h={"Authorization":"Bearer "+p.read_text().strip()} if p.exists() else {};' +
			`r=urllib.request.Request(${JSON.stringify(url)},headers=h);` +
			'print(json.load(urllib.request.urlopen(r,timeout=3))["active"])';
		const res = await sandbox.exec(`python3 -c ${shellQuote(script)}`);
		if (!res.success) return null;
		// Whole output or nothing — `parseInt` would read 2 out of "2garbage", and a
		// half-parsed answer must count as unknown rather than steer reaping. The
		// safe-integer check rejects an absurdly long digit run, which would become
		// `Infinity` and serialize into the session record as a schema-invalid
		// `null`, making the record unreadable and its sandbox invisible to sweeps.
		const out = res.stdout.trim();
		const n = Number(out);
		return /^\d+$/.test(out) && Number.isSafeInteger(n) ? n : null;
	} catch (err) {
		if (err instanceof NotFoundError) throw err;
		return null;
	}
}

/** Injectable probe seam (tests fake the kernel answer without an exec fake). May throw `NotFoundError`. */
export type ConnectionProbe = (
	sandbox: SandboxInstance,
	basePath?: string,
) => Promise<number | null>;
