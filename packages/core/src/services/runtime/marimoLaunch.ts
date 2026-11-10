/**
 * How marimo is launched inside a sandbox. Strategies are inferred per-source
 * (see launchStrategy.ts); the default is the project-managed env.
 */
import { parse as parseToml } from 'smol-toml';
import type { RuntimeContributions } from '../../ports/integrations';
import type { SessionMode } from '../../constants';
import { runtimePackageCommand } from './runtimePackageCommand';
import { shellQuote } from './shell';
import { loggingCommand } from './logging';
import { mergeRuntimePackages } from '../integrations/runtimePackages';
export { MARIMO_VERSION_COMMAND } from './runtimePackageCommand';

/**
 * `edit`/`app` serve a browser; `job` runs the notebook to completion with
 * `marimo export html` and exits (see services/jobs/JobRunner.ts).
 */
export type MarimoLaunchMode = SessionMode | 'job';

export interface MarimoLaunchParams extends RuntimeContributions {
	/** Process-visible path to the Hub-managed Python logging bootstrap. */
	loggingDirectory?: string;
	/** True only for a dependency-free pyproject inspected during workspace transfer. */
	skipPyprojectSetup?: boolean;
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
	/** File containing marimo's session token. Jobs and legacy tokenless launches omit it. */
	tokenPasswordFile?: string;
	/**
	 * Optional path prefix marimo serves under, passed as `--base-url`. Set in
	 * `proxy` exposure mode (e.g. `/proxy/<token>`) so the kernel's asset and
	 * websocket URLs resolve beneath the proxied prefix. Omit to serve at root.
	 */
	baseUrl?: string;
	cookiePartitioned?: boolean;
	allowedOrigin?: string;
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
const commonFlags = ({
	host,
	port,
	assetUrl,
	baseUrl,
	tokenPasswordFile,
	allowedOrigin,
}: MarimoLaunchParams) => {
	const assetUrlArg = assetUrl ? ` --asset-url=${shellQuote(assetUrl)}` : '';
	const baseUrlArg = baseUrl ? ` --base-url=${shellQuote(baseUrl)}` : '';
	const originArg = allowedOrigin ? ` --allow-origins=${shellQuote(allowedOrigin)}` : '';
	if (tokenPasswordFile === '') throw new Error('Token password file path cannot be empty');
	const tokenArg =
		tokenPasswordFile !== undefined
			? `--token --token-password-file ${shellQuote(tokenPasswordFile)}`
			: '--no-token';
	return `--headless ${tokenArg} --host ${host} --port ${port}${assetUrlArg}${baseUrlArg}${originArg}`;
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

/** The mode-dependent tail of every strategy: `marimo <global flags> <subcommand> …`. */
function marimoCommand(p: MarimoLaunchParams, extraFlags = ''): string {
	const mode = p.mode ?? 'edit';
	const { subcommand, flags } = LAUNCH_MODES[mode];
	// marimo's startup URL contains access_token. Suppress it before sandbox
	// adapters capture process output; jobs do not start an authenticated server.
	const globalFlags = mode === 'job' ? '' : '--quiet ';
	return `marimo ${globalFlags}${subcommand} ${extraFlags}${shellQuote(p.notebookFile)} ${flags(p)}`;
}

function launchCommand(p: MarimoLaunchParams, sandbox = false): string {
	if (sandbox) {
		const packages = mergeRuntimePackages(p.runtimePackages ?? []);
		const flags = packages.map((requirement) => ` --with ${shellQuote(requirement)}`).join('');
		const command = marimoCommand(p, '--sandbox ');
		return `uv run --with marimo${flags} ${loggingCommand(
			p.loggingDirectory,
			p.loggingDirectory || packages.length > 0 ? `python -m ${command}` : command,
		)}`;
	}
	if (p.runtimePackages?.length || p.loggingDirectory) {
		return runtimePackageCommand(
			p.runtimePackages ?? [],
			loggingCommand(p.loggingDirectory, `python -m ${marimoCommand(p)}`),
		);
	}
	return runtimePackageCommand([], marimoCommand(p));
}

// Unknown manifests need sandbox validation. Empty projects use the image environment;
// a [project] table lets `uv add` work. Setup failures prevent kernel launch.
// Defer bytecode compilation until import. Images must not set the conflicting UV_COMPILE_BYTECODE.
const PYPROJECT_LAYER_SETUP = `{ status=0; python3 -c "import pathlib,sys,tomllib;path=pathlib.Path('pyproject.toml');data=tomllib.loads(path.read_text()) if path.exists() else {};sys.exit(0 if data.get('project',{}).get('dependencies') else 2)" || status=$?; if [ "$status" -eq 0 ]; then uv sync --inexact --no-install-package marimo --no-compile-bytecode; elif [ "$status" -eq 2 ]; then if ! grep -q '^\\[project\\]' pyproject.toml 2>/dev/null; then rm -f pyproject.toml && uv init --bare --no-package --vcs none --name notebook --description "Built in marimohub"; fi; else exit "$status"; fi; }`;

export const EMPTY_PYPROJECT =
	'[project]\nname = "notebook"\nversion = "0.1.0"\ndescription = "Built in marimohub"\ndependencies = []\n';

export function preparePyproject(input: string | Uint8Array): {
	content: string | Uint8Array;
	skipSetup: boolean;
} {
	let content = input;
	try {
		if (typeof content !== 'string')
			content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
		// smol-toml accepts a BOM, but Python's tomllib rejects it.
		if (content.startsWith('\uFEFF')) return { content, skipSetup: false };
		const data = parseToml(content);
		if (Object.keys(data).length === 0) return { content: EMPTY_PYPROJECT, skipSetup: true };
		const project: unknown = data.project;
		if (
			project &&
			typeof project === 'object' &&
			(Object.getPrototypeOf(project) === Object.prototype ||
				Object.getPrototypeOf(project) === null)
		) {
			const dependencies = 'dependencies' in project ? project.dependencies : undefined;
			if (dependencies === undefined || (Array.isArray(dependencies) && dependencies.length === 0))
				return { content, skipSetup: true };
		}
	} catch {
		// Keep sandbox-side validation and its existing user-facing setup error.
	}
	return { content, skipSetup: false };
}

function pyprojectSetup(p: MarimoLaunchParams): MarimoSetupStep[] {
	// Startup scripts can replace the transferred dependency manifest.
	return p.skipPyprojectSetup && !p.startupScripts?.length
		? []
		: [{ name: 'pyproject_layer', command: PYPROJECT_LAYER_SETUP }];
}

// Match `uv run --no-sync`: it uses UV_PROJECT_ENVIRONMENT or .venv, ignoring VIRTUAL_ENV.
// Sandbox images pre-create this environment; compute-local needs the create-if-missing guard.
const PIN_ENV_EXPANSION = '${UV_PROJECT_ENVIRONMENT:-.venv}';
const PIN_ENV = `"${PIN_ENV_EXPANSION}"`;

// Keep requirements in the sandbox's environment to avoid shared-host collisions,
// workspace capture, and overwriting the repository's requirements.txt.
const SCRIPT_REQUIREMENTS = `"${PIN_ENV_EXPANSION}/marimohub-script-requirements.txt"`;

// uv 0.10.9's pip interface ignores UV_NO_BUILD, unlike uv sync/export.
// Keep the positional arguments local to this setup step.
const SCRIPT_PIN_INSTALL = [
	'(set --; case "${UV_NO_BUILD-}" in',
	'1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) set -- --no-build ;;',
	"''|0|[Ff][Aa][Ll][Ss][Ee]|[Nn][Oo]|[Oo][Ff][Ff]) ;;",
	'*) printf "%s\\n" "UV_NO_BUILD must be a boolean" >&2; exit 2 ;;',
	'esac;',
	`uv pip install --python ${PIN_ENV} "$@" -r ${SCRIPT_REQUIREMENTS})`,
].join(' ');

export const MARIMO_LAUNCH_STRATEGIES = {
	// Add notebook dependencies to the image environment without replacing its marimo.
	// Launch with --no-sync to preserve that environment.
	'uv-sync-edit': (p) => ({
		setup: pyprojectSetup(p),
		start: launchCommand(p),
	}),

	// Install PEP 723 pins after project dependencies. Prune marimo's dependency tree
	// to preserve the image version; --no-hashes accepts the unhashed base environment.
	'uv-script-pins': (p) => ({
		setup: [
			...pyprojectSetup(p),
			{ name: 'ensure_pin_env', command: `{ [ -d ${PIN_ENV} ] || uv venv ${PIN_ENV}; }` },
			{
				name: 'export_script_pins',
				command: `uv export --script ${shellQuote(p.notebookFile)} --format requirements-txt --no-hashes --prune marimo -o ${SCRIPT_REQUIREMENTS}`,
			},
			{
				name: 'install_script_pins',
				command: SCRIPT_PIN_INSTALL,
			},
		],
		start: launchCommand(p),
	}),

	// marimo builds its own venv from PEP 723 metadata. Unselected today; kept
	// as the future path for markdown notebooks, whose metadata lives in YAML
	// frontmatter that uv can't parse (but marimo --sandbox can).
	'uv-sandbox': (p) => ({
		setup: [],
		start: launchCommand(p, true),
	}),
} satisfies Record<string, MarimoLaunchStrategy>;

export type MarimoLaunchStrategyName = keyof typeof MARIMO_LAUNCH_STRATEGIES;

export const DEFAULT_LAUNCH_STRATEGY: MarimoLaunchStrategyName = 'uv-sync-edit';

export function buildMarimoLaunch(
	params: MarimoLaunchParams,
	strategy: MarimoLaunchStrategyName = DEFAULT_LAUNCH_STRATEGY,
): MarimoLaunchPlan {
	const plan = MARIMO_LAUNCH_STRATEGIES[strategy](params);

	return {
		...plan,
		start:
			params.mode !== 'job' &&
			params.cookiePartitioned !== undefined &&
			params.tokenPasswordFile !== undefined
				? `(export MARIMO_SERVER_SESSION_COOKIE_PARTITIONED=${params.cookiePartitioned}; ${plan.start})`
				: plan.start,
		setup: [
			...(params.startupScripts ?? []).map((path, index) => ({
				name: `startup_script_${index + 1}`,
				command: `sh -e ${shellQuote(path)}`,
			})),
			...plan.setup,
			...(params.mode === 'job'
				? [{ name: 'job_output_dir', command: "mkdir -p '__marimo__'" }]
				: []),
		],
	};
}
