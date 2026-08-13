/**
 * How marimo is launched inside a sandbox. Strategies are inferred per-source
 * (see launchStrategy.ts); the default is the project-managed env.
 */
import type { SessionMode } from '../../constants';
import { shellQuote } from './shell';

export interface MarimoLaunchParams {
	notebookFile: string;
	port: number;
	/** Bind 0.0.0.0 so the external ingress can reach the kernel. */
	host: string;
	/** Session mode; picks the launch strategy in `LAUNCH_MODES`. Default `edit`. */
	mode?: SessionMode;
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

/** Flags both subcommands accept, spelled identically. */
const commonFlags = ({ host, port, assetUrl, baseUrl }: MarimoLaunchParams) => {
	const assetUrlArg = assetUrl ? ` --asset-url="${assetUrl}"` : '';
	const baseUrlArg = baseUrl ? ` --base-url="${baseUrl}"` : '';
	return `--headless --no-token --host ${host} --port ${port}${assetUrlArg}${baseUrlArg}`;
};

interface ModeLaunch {
	/** The marimo subcommand implementing this session mode. */
	subcommand: 'edit' | 'run';
	flags: (p: MarimoLaunchParams) => string;
}

/**
 * Per-mode launch strategy. `app` maps to `marimo run`, which accepts every
 * common flag including `--asset-url` (a hidden option on `run` — verified
 * against marimo 0.23.x `cli.py`, so app pages get the CDN fast path too);
 * only `--convert` is edit-only. `--include-code`, `--watch`, and
 * `--session-ttl` are deliberately left at marimo's defaults; the default TTL
 * (120s) is what garbage-collects a disconnected viewer's kernel.
 */
const LAUNCH_MODES: Record<SessionMode, ModeLaunch> = {
	edit: {
		subcommand: 'edit',
		// --convert opens a non-marimo file (e.g. a plain script); no-op on real
		// marimo notebooks, so it's safe to always pass.
		flags: (p) => `--convert ${commonFlags(p)}`,
	},
	app: {
		subcommand: 'run',
		flags: commonFlags,
	},
};

/** The mode-dependent tail of every strategy: `marimo <subcommand> <file> <flags>`. */
function marimoCommand(p: MarimoLaunchParams, extraFlags = ''): string {
	const { subcommand, flags } = LAUNCH_MODES[p.mode ?? 'edit'];
	return `marimo ${subcommand} ${extraFlags}${shellQuote(p.notebookFile)} ${flags(p)}`;
}

// Sync only when the notebook declares real deps; an empty one just gets a
// `[project]` table (so `uv add` works) and runs from the pre-installed
// /opt/venv via `--no-sync`. --no-compile-bytecode skips ~5s of compiling
// freshly-added deps on the launch path (lazy-compiled on import instead);
// --no-build keeps it to wheels so a source build can't run arbitrary code /
// stall the launch. The image must NOT set UV_COMPILE_BYTECODE (it would
// conflict with --no-compile-bytecode). `|| true` never blocks launch.
const PYPROJECT_LAYER_SETUP = `if python3 -c "import tomllib,sys;sys.exit(0 if tomllib.load(open('pyproject.toml','rb')).get('project',{}).get('dependencies') else 1)" 2>/dev/null; then uv sync --inexact --no-compile-bytecode --no-build || true; elif ! grep -q '^\\[project\\]' pyproject.toml 2>/dev/null; then { rm -f pyproject.toml && uv init --vcs none --name notebook --description "Built in marimohub"; } || true; fi`;

// Outside the workspace (keeps the marimo file browser clean, can't clobber a
// synced repo's own requirements.txt) and unique per launch shell: `$$` is the
// PID of the single `sh -c` the setup runs in, so local sandboxes — which
// share the host /tmp — can't clobber each other between export and install.
const SCRIPT_REQUIREMENTS = '/tmp/marimohub-script-requirements-$$.txt';

// The env the kernel's `uv run --no-sync` will use — uv resolves the project
// env as UV_PROJECT_ENVIRONMENT, else `.venv` in the project dir. Deliberately
// not VIRTUAL_ENV: `uv run` ignores it, so pins installed there would be
// invisible to the kernel. Local dev (compute-local) has neither var nor an
// existing env, hence the create-if-missing guard — a no-op on sandbox images,
// whose contract pre-creates UV_PROJECT_ENVIRONMENT.
const PIN_ENV = '"${UV_PROJECT_ENVIRONMENT:-.venv}"';

export const MARIMO_LAUNCH_STRATEGIES = {
	// marimohub's default. The sandbox image pre-installs marimo (pinned) plus
	// popular libraries into the project env (UV_PROJECT_ENVIRONMENT), so the base
	// case needs no install and startup is near-instant. A notebook's own deps live
	// in pyproject.toml; `uv sync --inexact` adds them to that env without removing
	// the pre-installed base, then `--no-sync` runs marimo straight from it. Unlike
	// marimo's `--sandbox` (which force-refreshes when a notebook declares no
	// inline deps), this never refetches.
	'uv-sync-edit': (p) => ({
		setup: [PYPROJECT_LAYER_SETUP],
		start: `uv run --no-sync ${marimoCommand(p)}`,
	}),

	// Git-synced notebooks with PEP 723 inline metadata: the pyproject layer runs
	// first (lenient, as above), then the script's pins install into the same base
	// env — last, so they win. No `|| true` on the pin steps: declared pins must
	// fail the launch loudly (uv's error surfaces via the kernel logs), never be
	// silently ignored. --no-hashes because hash checking rejects the unhashed
	// base env.
	'uv-script-pins': (p) => ({
		setup: [
			PYPROJECT_LAYER_SETUP,
			`uv export --script ${shellQuote(p.notebookFile)} --format requirements-txt --no-hashes -o ${SCRIPT_REQUIREMENTS}`,
			`[ -d ${PIN_ENV} ] || uv venv ${PIN_ENV}`,
			`uv pip install --python ${PIN_ENV} --no-build -r ${SCRIPT_REQUIREMENTS}`,
		],
		start: `uv run --no-sync ${marimoCommand(p)}`,
	}),

	// marimo builds its own venv from PEP 723 metadata. Unselected today; kept
	// as the future path for markdown notebooks, whose metadata lives in YAML
	// frontmatter that uv can't parse (but marimo --sandbox can).
	'uv-sandbox': (p) => ({
		setup: [],
		start: `uv run --with marimo ${marimoCommand(p, '--sandbox ')}`,
	}),
} satisfies Record<string, MarimoLaunchStrategy>;

export type MarimoLaunchStrategyName = keyof typeof MARIMO_LAUNCH_STRATEGIES;

export const DEFAULT_LAUNCH_STRATEGY: MarimoLaunchStrategyName = 'uv-sync-edit';

export function buildMarimoLaunch(
	params: MarimoLaunchParams,
	strategy: MarimoLaunchStrategyName = DEFAULT_LAUNCH_STRATEGY,
): MarimoLaunchPlan {
	return MARIMO_LAUNCH_STRATEGIES[strategy](params);
}
