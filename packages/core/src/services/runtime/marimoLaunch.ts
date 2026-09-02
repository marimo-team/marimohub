/**
 * How marimo is launched inside a sandbox. Strategies are inferred per-source
 * (see launchStrategy.ts); the default is the project-managed env.
 */
import type { SessionMode } from '../../constants';
import { shellQuote } from './shell';

/**
 * `edit`/`app` serve a browser; `job` runs the notebook to completion with
 * `marimo export html` and exits (see services/jobs/JobRunner.ts).
 */
export type MarimoLaunchMode = SessionMode | 'job';

export interface MarimoLaunchParams {
	notebookFile: string;
	port: number;
	/** Bind 0.0.0.0 so the external ingress can reach the kernel. */
	host: string;
	/** Launch mode; picks the subcommand in `LAUNCH_MODES`. Default `edit`. */
	mode?: MarimoLaunchMode;
	/** Job mode: workdir-relative path the rendered HTML is written to. */
	outputFile?: string;
	/** Optional CDN base for the frontend, passed as --asset-url. */
	assetUrl?: string;
	/**
	 * Optional path prefix marimo serves under, passed as `--base-url`. Set in
	 * `proxy` exposure mode (e.g. `/proxy/<token>`) so the kernel's asset and
	 * websocket URLs resolve beneath the proxied prefix. Omit to serve at root.
	 */
	baseUrl?: string;
	watch?: boolean;
}

export interface MarimoLaunchPlan {
	/** Commands run (via exec, in the notebook dir) before the kernel. */
	setup: MarimoSetupStep[];
	/** The long-running command that starts marimo (via startProcess). */
	start: string;
}

export interface MarimoSetupStep {
	name: string;
	command: string;
}

export type MarimoLaunchStrategy = (params: MarimoLaunchParams) => MarimoLaunchPlan;

/** Flags both subcommands accept, spelled identically. */
const commonFlags = ({ host, port, assetUrl, baseUrl }: MarimoLaunchParams) => {
	const assetUrlArg = assetUrl ? ` --asset-url="${assetUrl}"` : '';
	const baseUrlArg = baseUrl ? ` --base-url="${baseUrl}"` : '';
	return `--headless --no-token --host ${host} --port ${port}${assetUrlArg}${baseUrlArg}`;
};

interface ModeLaunch {
	/** The marimo subcommand implementing this launch mode. */
	subcommand: 'edit' | 'run' | 'export html';
	flags: (p: MarimoLaunchParams) => string;
}

/** Job mode's default export target when the caller passes none. */
const DEFAULT_JOB_OUTPUT_FILE = '__marimo__/job_output.html';

/**
 * Per-mode launch strategy. `app` maps to `marimo run`, which accepts every
 * common flag including `--asset-url` (a hidden option on `run` — verified
 * against marimo 0.23.x `cli.py`, so app pages get the CDN fast path too);
 * only `--convert` and `--watch` are edit-only. `--include-code` and
 * `--session-ttl` stay at marimo's defaults; the default TTL (120s) is what
 * garbage-collects a disconnected viewer's kernel.
 */
const LAUNCH_MODES: Record<MarimoLaunchMode, ModeLaunch> = {
	edit: {
		subcommand: 'edit',
		// --convert opens a non-marimo .py file (e.g. a plain script); no-op on real
		// marimo notebooks, so it's safe to always pass for .py. Its fallback can
		// rewrite the file as Python, so never pass it for md/qmd notebooks.
		flags: (p) =>
			`${p.notebookFile.endsWith('.py') ? '--convert ' : ''}${p.watch ? '--watch ' : ''}${commonFlags(p)}`,
	},
	app: {
		subcommand: 'run',
		flags: commonFlags,
	},
	// `marimo export html` executes the notebook and writes the rendered outputs
	// (verified against marimo 0.24 `cli.py`: exit 0 on success, exit 1 with the
	// HTML still written when a cell raises). Notebook parameters are appended by
	// the runner after `--`, never here.
	job: {
		subcommand: 'export html',
		flags: (p) => `-o ${shellQuote(p.outputFile ?? DEFAULT_JOB_OUTPUT_FILE)}`,
	},
};

/** The mode-dependent tail of every strategy: `marimo <subcommand> <file> <flags>`. */
function marimoCommand(p: MarimoLaunchParams, extraFlags = ''): string {
	const { subcommand, flags } = LAUNCH_MODES[p.mode ?? 'edit'];
	return `marimo ${subcommand} ${extraFlags}${shellQuote(p.notebookFile)} ${flags(p)}`;
}

// Sync only when the notebook declares real deps; an empty one just gets a
// `[project]` table (so `uv add` works) and runs from the pre-installed
// image environment via `--no-sync`. --no-compile-bytecode skips ~5s of compiling
// freshly-added deps on the launch path (lazy-compiled on import instead);
// --no-build keeps it to wheels so a source build can't run arbitrary code /
// stall the launch. The image must NOT set UV_COMPILE_BYTECODE (it would
// conflict with --no-compile-bytecode). A failure is fatal: the provisioner
// reports it as PYTHON_ENV_SETUP_FAILED before starting the kernel.
const PYPROJECT_LAYER_SETUP = `{ status=0; python3 -c "import pathlib,sys,tomllib;path=pathlib.Path('pyproject.toml');data=tomllib.loads(path.read_text()) if path.exists() else {};sys.exit(0 if data.get('project',{}).get('dependencies') else 2)" || status=$?; if [ "$status" -eq 0 ]; then uv sync --inexact --no-install-package marimo --no-compile-bytecode --no-build; elif [ "$status" -eq 2 ]; then if ! grep -q '^\\[project\\]' pyproject.toml 2>/dev/null; then rm -f pyproject.toml && uv init --bare --no-package --vcs none --name notebook --description "Built in marimohub"; fi; else exit "$status"; fi; }`;

// The env the kernel's `uv run --no-sync` will use — uv resolves the project
// env as UV_PROJECT_ENVIRONMENT, else `.venv` in the project dir. Deliberately
// not VIRTUAL_ENV: `uv run` ignores it, so pins installed there would be
// invisible to the kernel. Local dev (compute-local) has neither var nor an
// existing env, hence the create-if-missing guard — a no-op on sandbox images,
// whose contract pre-creates UV_PROJECT_ENVIRONMENT.
const PIN_ENV_EXPANSION = '${UV_PROJECT_ENVIRONMENT:-.venv}';
const PIN_ENV = `"${PIN_ENV_EXPANSION}"`;

// Inside the pin env: per-sandbox on every backend (a container's env dies
// with it; a local sandbox's .venv is removed with its root), so nothing
// accumulates on a shared host /tmp and concurrent launches can't clobber
// each other. Also keeps it out of workspace capture and away from a synced
// repo's own requirements.txt.
const SCRIPT_REQUIREMENTS = `"${PIN_ENV_EXPANSION}/marimohub-script-requirements.txt"`;

export const MARIMO_LAUNCH_STRATEGIES = {
	// marimohub's default. The sandbox image pre-installs marimo (pinned) plus
	// popular libraries into the project env (UV_PROJECT_ENVIRONMENT), so the base
	// case needs no install and startup is near-instant. A notebook's own deps live
	// in pyproject.toml; `uv sync --inexact --no-install-package marimo` adds them
	// without replacing the image-owned marimo, then `--no-sync` runs straight from it. Unlike
	// marimo's `--sandbox` (which force-refreshes when a notebook declares no
	// inline deps), this never refetches.
	'uv-sync-edit': (p) => ({
		setup: [{ name: 'pyproject_layer', command: PYPROJECT_LAYER_SETUP }],
		start: `uv run --no-sync ${marimoCommand(p)}`,
	}),

	// Git-synced notebooks with PEP 723 inline metadata: the pyproject layer runs
	// first, then the script's pins install into the same base env. Prune marimo's
	// dependency tree so a notebook's inline marimo pin cannot replace the
	// bytecode-compiled image version. --no-hashes because hash checking rejects
	// the unhashed base env.
	'uv-script-pins': (p) => ({
		setup: [
			{ name: 'pyproject_layer', command: PYPROJECT_LAYER_SETUP },
			{ name: 'ensure_pin_env', command: `{ [ -d ${PIN_ENV} ] || uv venv ${PIN_ENV}; }` },
			{
				name: 'export_script_pins',
				command: `uv export --script ${shellQuote(p.notebookFile)} --format requirements-txt --no-hashes --prune marimo -o ${SCRIPT_REQUIREMENTS}`,
			},
			{
				name: 'install_script_pins',
				command: `uv pip install --python ${PIN_ENV} --no-build -r ${SCRIPT_REQUIREMENTS}`,
			},
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
	const plan = MARIMO_LAUNCH_STRATEGIES[strategy](params);
	if (params.mode !== 'job') return plan;
	return {
		...plan,
		setup: [...plan.setup, { name: 'job_output_dir', command: "mkdir -p '__marimo__'" }],
	};
}
