/**
 * How marimo is launched inside a sandbox. Pick a strategy via ACTIVE_STRATEGY
 * below to experiment with different ways of provisioning the env.
 */
import { shellQuote } from './shell';

export interface MarimoLaunchParams {
	notebookFile: string;
	port: number;
	/** Bind 0.0.0.0 so the external ingress can reach the kernel. */
	host: string;
	/** Optional CDN base for the frontend, passed as --asset-url. */
	assetUrl?: string;
	/**
	 * Optional path prefix marimo serves under, passed as `--base-url`. Set in
	 * `proxy` exposure mode (e.g. `/proxy/<token>`) so the kernel's asset and
	 * websocket URLs resolve beneath the proxied prefix. Omit to serve at root.
	 */
	baseUrl?: string;
}

export interface MarimoLaunchPlan {
	/** Commands run (via exec, in the notebook dir) before the kernel. */
	setup: string[];
	/** The long-running command that starts marimo (via startProcess). */
	start: string;
}

export type MarimoLaunchStrategy = (params: MarimoLaunchParams) => MarimoLaunchPlan;

function editFlags({ host, port, assetUrl, baseUrl }: MarimoLaunchParams): string {
	const assetUrlArg = assetUrl ? ` --asset-url="${assetUrl}"` : '';
	const baseUrlArg = baseUrl ? ` --base-url="${baseUrl}"` : '';
	// --convert opens a non-marimo file (e.g. a plain script); no-op on real
	// marimo notebooks, so it's safe to always pass.
	return `--convert --headless --no-token --host ${host} --port ${port}${assetUrlArg}${baseUrlArg}`;
}

export const MARIMO_LAUNCH_STRATEGIES = {
	// marimohub's strategy. The sandbox image pre-installs marimo (pinned) plus
	// popular libraries into the project env (UV_PROJECT_ENVIRONMENT), so the base
	// case needs no install and startup is near-instant. A notebook's own deps live
	// in pyproject.toml (not PEP 723 inline metadata); `uv sync --inexact` adds them
	// to that env without removing the pre-installed base, then `--no-sync` runs
	// marimo straight from it. Unlike marimo's `--sandbox` (which force-refreshes
	// when a notebook declares no inline deps — ours never do), this never refetches.
	'uv-sync-edit': (p) => ({
		setup: [
			// Sync only when the notebook declares real deps; an empty one just gets a
			// `[project]` table (so `uv add` works) and runs from the pre-installed
			// /opt/venv via `--no-sync`. --no-compile-bytecode skips ~5s of compiling
			// freshly-added deps on the launch path (lazy-compiled on import instead);
			// --no-build keeps it to wheels so a source build can't run arbitrary code /
			// stall the launch. The image must NOT set UV_COMPILE_BYTECODE (it would
			// conflict with --no-compile-bytecode). `|| true` never blocks launch.
			`if python3 -c "import tomllib,sys;sys.exit(0 if tomllib.load(open('pyproject.toml','rb')).get('project',{}).get('dependencies') else 1)" 2>/dev/null; then uv sync --inexact --no-compile-bytecode --no-build || true; elif ! grep -q '^\\[project\\]' pyproject.toml 2>/dev/null; then { rm -f pyproject.toml && uv init --vcs none --name notebooks; } || true; fi`,
		],
		start: `uv run --no-sync marimo edit ${shellQuote(p.notebookFile)} ${editFlags(p)}`,
	}),

	// Project mode without a prior `uv sync` — leaner, but `uv run` doesn't reliably
	// materialize project deps on first invocation. Prefer `uv-sync-edit`.
	'uv-run-edit': (p) => ({
		setup: [],
		start: `uv run marimo edit ${shellQuote(p.notebookFile)} ${editFlags(p)}`,
	}),

	// Export the script's PEP 723 deps to requirements.txt, then run against that.
	'uv-export-requirements': (p) => ({
		setup: [
			`uv export --script ${shellQuote(p.notebookFile)} --format requirements-txt > requirements.txt`,
		],
		start: `uv run --with marimo --with-requirements=requirements.txt marimo edit ${shellQuote(p.notebookFile)} ${editFlags(p)}`,
	}),

	// marimo builds its own venv from PEP 723 metadata; force-refreshes when the
	// script declares no deps.
	'uv-sandbox': (p) => ({
		setup: [],
		start: `uv run --with marimo marimo edit --sandbox ${shellQuote(p.notebookFile)} ${editFlags(p)}`,
	}),
} satisfies Record<string, MarimoLaunchStrategy>;

export type MarimoLaunchStrategyName = keyof typeof MARIMO_LAUNCH_STRATEGIES;

const ACTIVE_STRATEGY: MarimoLaunchStrategyName = 'uv-sync-edit';

export function buildMarimoLaunch(params: MarimoLaunchParams): MarimoLaunchPlan {
	return MARIMO_LAUNCH_STRATEGIES[ACTIVE_STRATEGY](params);
}
