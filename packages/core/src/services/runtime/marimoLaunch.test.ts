import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildMarimoLaunch, MARIMO_LAUNCH_STRATEGIES, preparePyproject } from './marimoLaunch';
import type { MarimoLaunchParams } from './marimoLaunch';

const BASE: MarimoLaunchParams = {
	notebookFile: 'notebook.py',
	port: 2718,
	host: '0.0.0.0',
	assetUrl: 'https://cdn.example.com/assets',
	baseUrl: '/proxy/tok',
	tokenPasswordFile: '/tmp/.marimohub-kernel-token',
};

describe('buildMarimoLaunch', () => {
	it.each([true, false])(
		'carries CHIPS=%s through runtime-package commands',
		(cookiePartitioned) => {
			const plan = buildMarimoLaunch({
				...BASE,
				cookiePartitioned,
				runtimePackages: ['rich==13.9.4'],
				startupScripts: ['/tmp/start.sh'],
			});
			expect(plan.setup[0]).toEqual({ name: 'startup_script_1', command: "sh -e '/tmp/start.sh'" });
			const result = execFileSync(
				'sh',
				[
					'-c',
					`uv() { case "$*" in *importlib.metadata*) printf '0.24.2' ;; *) printenv MARIMO_SERVER_SESSION_COOKIE_PARTITIONED ;; esac; }; ${plan.start}`,
				],
				{
					encoding: 'utf8',
					env: {
						...process.env,
						MARIMO_SERVER_SESSION_COOKIE_PARTITIONED: String(!cookiePartitioned),
					},
				},
			);
			expect(result.trim()).toBe(String(cookiePartitioned));
		},
	);

	it.each(['edit', 'app', 'job'] as const)(
		'resolves runtime packages only at launch without extra setup for %s',
		(mode) => {
			const plan = buildMarimoLaunch(
				{ ...BASE, mode, runtimePackages: ['marimo-studio[deno]==0.4.1'] },
				'uv-script-pins',
			);
			expect(plan.setup).toEqual(buildMarimoLaunch({ ...BASE, mode }, 'uv-script-pins').setup);
			expect(plan.start.match(/uv run --no-sync --with/g)).toHaveLength(1);
			expect(plan.start).toContain("--with 'marimo-studio[deno]==0.4.1'");
			expect(plan.start).toContain('--with "marimo==$marimohub_marimo_version"');
			expect(plan.start).toContain('python -m marimo');
			expect(plan.start).toContain('--no-sync');
		},
	);

	it('omits the runtime layer when an integration is disabled', () => {
		const plan = buildMarimoLaunch({ ...BASE, runtimePackages: [] });
		expect(plan).toEqual(buildMarimoLaunch(BASE));
		expect(plan.start).not.toContain('--with');
	});
	it.each(['edit', 'app', 'job'] as const)(
		'keeps uv-sandbox marimo provisioning with logging in %s mode',
		(mode) => {
			const plan = buildMarimoLaunch(
				{ ...BASE, mode, loggingDirectory: '/tmp/logging' },
				'uv-sandbox',
			);
			expect(plan.start).toMatch(/^uv run --with marimo env PYTHONPATH=/);
			expect(plan.start).toContain('python -m marimo');
			expect(plan.start).toContain('--sandbox');
			expect(plan.start).not.toContain('--no-sync');
			expect(plan.start).not.toContain('marimohub_marimo_version');
		},
	);
	it.each([undefined, '/tmp/logging'])(
		'layers sandbox runtime packages without a preinstalled marimo: %s',
		(loggingDirectory) => {
			const plan = buildMarimoLaunch(
				{ ...BASE, loggingDirectory, runtimePackages: ['rich==13.9.4'] },
				'uv-sandbox',
			);
			expect(plan.start).toMatch(/^uv run --with marimo --with 'rich==13.9.4' /);
			expect(plan.start).toContain('python -m marimo --quiet edit --sandbox');
			expect(plan.start).not.toContain('marimohub_marimo_version');
		},
	);
	for (const strategy of ['uv-sync-edit', 'uv-script-pins', 'uv-sandbox'] as const) {
		it.each(['edit', 'app'] as const)(`${strategy} configures CHIPS for %s`, (mode) => {
			for (const cookiePartitioned of [true, false]) {
				const { start } = buildMarimoLaunch({ ...BASE, mode, cookiePartitioned }, strategy);
				expect(start).toMatch(
					new RegExp(
						`^\\(export MARIMO_SERVER_SESSION_COOKIE_PARTITIONED=${cookiePartitioned}; uv run `,
					),
				);
				expect(start).not.toContain('MARIMO_SESSION_COOKIE_SAMESITE');
			}
		});
	}

	it('does not configure cookies for jobs, tokenless launches, or an unset policy', () => {
		for (const params of [
			BASE,
			{ ...BASE, mode: 'job' as const, cookiePartitioned: true },
			{ ...BASE, tokenPasswordFile: undefined, cookiePartitioned: true },
		]) {
			expect(buildMarimoLaunch(params).start).not.toContain('MARIMO_SERVER_SESSION_COOKIE');
		}
	});

	it.each(['uv-sync-edit', 'uv-script-pins', 'uv-sandbox'] as const)(
		'%s passes the exact public origin to browser sessions only',
		(strategy) => {
			for (const mode of ['edit', 'app', 'job'] as const) {
				const { start } = buildMarimoLaunch(
					{ ...BASE, mode, allowedOrigin: 'https://kernel.example:8443' },
					strategy,
				);
				if (mode === 'job') expect(start).not.toContain('--allow-origins');
				else expect(start).toContain("--allow-origins='https://kernel.example:8443'");
			}
		},
	);

	it('defaults to edit mode', () => {
		const { start } = buildMarimoLaunch(BASE);
		expect(start).toContain('marimo --quiet edit');
		expect(start).not.toContain('marimo --quiet run');
	});

	it('edit keeps --convert and --asset-url', () => {
		const { start } = buildMarimoLaunch({ ...BASE, mode: 'edit' });
		expect(start).toContain('--convert');
		expect(start).toContain("--asset-url='https://cdn.example.com/assets'");
		expect(start).toContain("--base-url='/proxy/tok'");
	});

	it('adds file watching only when an edit surface requests it', () => {
		expect(buildMarimoLaunch({ ...BASE, mode: 'edit', watch: true }).start).toContain('--watch');
		expect(buildMarimoLaunch({ ...BASE, mode: 'edit' }).start).not.toContain('--watch');
		expect(buildMarimoLaunch({ ...BASE, mode: 'app', watch: true }).start).not.toContain('--watch');
	});

	// --convert's fallback can rewrite a file as Python, so it must never reach a
	// markdown-family notebook.
	for (const file of ['docs/page.md', 'page.markdown', 'reports/q3.qmd']) {
		it(`edit drops --convert for ${file}`, () => {
			const { start } = buildMarimoLaunch({ ...BASE, mode: 'edit', notebookFile: file });
			expect(start).toContain('marimo --quiet edit');
			expect(start).not.toContain('--convert');
		});
	}

	it('edit keeps --convert for a nested .py entry (synced sources set entryNotebook)', () => {
		const { start } = buildMarimoLaunch({ ...BASE, mode: 'edit', notebookFile: 'apps/main.py' });
		expect(start).toContain('--convert');
	});

	it('app drops --convert but keeps host/port/asset-url/base-url', () => {
		const { start } = buildMarimoLaunch({ ...BASE, mode: 'app' });
		expect(start).toContain('marimo --quiet run');
		expect(start).not.toContain('--convert');
		expect(start).toContain(
			"--headless --token --token-password-file '/tmp/.marimohub-kernel-token' --host 0.0.0.0 --port 2718",
		);
		// A hidden-but-real option on `marimo run` — the CDN fast path applies to apps.
		expect(start).toContain("--asset-url='https://cdn.example.com/assets'");
		expect(start).toContain("--base-url='/proxy/tok'");
		// Deliberately left to marimo defaults (see LAUNCH_MODES).
		expect(start).not.toContain('--include-code');
		expect(start).not.toContain('--watch');
		expect(start).not.toContain('--session-ttl');
	});

	it('run keeps the uv wrapping identical to edit', () => {
		const edit = buildMarimoLaunch({ ...BASE, mode: 'edit' });
		const run = buildMarimoLaunch({ ...BASE, mode: 'app' });
		expect(edit.setup).toEqual(run.setup);
		const uvPrefix = (cmd: string) => cmd.slice(0, cmd.indexOf('marimo'));
		expect(uvPrefix(run.start)).toBe(uvPrefix(edit.start));
	});

	it('keeps the token value out of the launch command', () => {
		const { start } = buildMarimoLaunch({
			...BASE,
			tokenPasswordFile: '/tmp/token-file',
		});
		expect(start).toContain("--token-password-file '/tmp/token-file'");
		expect(start).not.toContain('mhub_kernel_secret');
	});

	it('retains tokenless launches for legacy callers without a token file', () => {
		const { start } = buildMarimoLaunch({ ...BASE, tokenPasswordFile: undefined });
		expect(start).toContain('marimo --quiet edit');
		expect(start).toContain('--no-token');
		expect(start).not.toContain('--token-password-file');
	});

	it('rejects an explicitly empty token file path instead of launching tokenless', () => {
		expect(() => buildMarimoLaunch({ ...BASE, tokenPasswordFile: '' })).toThrow(
			'Token password file path cannot be empty',
		);
	});

	it('job creates its output directory before exporting', () => {
		const { setup, start } = buildMarimoLaunch({ ...BASE, mode: 'job' });

		expect(setup.at(-1)).toEqual({
			name: 'job_output_dir',
			command: "mkdir -p '__marimo__'",
		});
		expect(start).toContain('marimo export html');
		expect(start).not.toContain('--quiet');
		expect(start).not.toContain('--token');
		expect(start).not.toContain('--no-token');
	});

	it('job does not establish a session-artifact contract for custom entries', () => {
		const { setup, start } = buildMarimoLaunch({
			...BASE,
			mode: 'job',
			notebookFile: 'apps/main.py',
		});

		expect(start).toContain("'apps/main.py'");
		expect(start).not.toContain('__marimo__/session');
		expect(start).not.toContain('cp ');
		expect(setup.at(-1)?.command).toBe("mkdir -p '__marimo__'");
	});

	// Every strategy must honor the mode and suppress the token-bearing startup URL.
	for (const [name, strategy] of Object.entries(MARIMO_LAUNCH_STRATEGIES)) {
		it(`strategy ${name} emits a quiet interactive subcommand`, () => {
			expect(strategy({ ...BASE, mode: 'edit' }).start).toContain('marimo --quiet edit');
			expect(strategy({ ...BASE, mode: 'app' }).start).toContain('marimo --quiet run');
		});
	}

	it('quotes the notebook file in both modes', () => {
		const { start } = buildMarimoLaunch({ ...BASE, mode: 'app', notebookFile: 'apps/my app.py' });
		expect(start).toContain("'apps/my app.py'");
	});

	it('initializes only a pyproject with marimohub metadata', () => {
		const [{ command: setup }] = buildMarimoLaunch(BASE).setup;
		expect(setup).toContain('uv init');
		expect(setup).toContain('--bare');
		expect(setup).toContain('--no-package');
		expect(setup).toContain('--name notebook');
		expect(setup).toContain('--description "Built in marimohub"');
	});

	it('names each setup layer for provision timing fields', () => {
		expect(buildMarimoLaunch(BASE).setup.map(({ name }) => name)).toEqual(['pyproject_layer']);
	});

	it('leaves the image-owned marimo installation untouched', () => {
		for (const strategy of ['uv-sync-edit', 'uv-script-pins'] as const) {
			const setup = buildMarimoLaunch(BASE, strategy)
				.setup.map(({ command }) => command)
				.join('\n');
			expect(setup).toContain('--no-install-package marimo');
			expect(setup).not.toContain('MARIMOHUB_MARIMO_VERSION');
			expect(setup).not.toContain('importlib.metadata');
			expect(setup).not.toContain('marimo==');
		}
	});

	it('reserves exit code 2 for no dependencies and propagates TOML parse failures', () => {
		const [{ command: pyproject }] = buildMarimoLaunch(BASE).setup;
		expect(pyproject).toContain('import pathlib,sys,tomllib');
		expect(pyproject).not.toContain("find_spec('tomllib')");
		expect(pyproject).toContain('else 2');
		expect(pyproject).toContain('elif [ "$status" -eq 2 ]');
		expect(pyproject).toContain('else exit "$status"');
	});

	describe('uv-script-pins', () => {
		const plan = buildMarimoLaunch({ ...BASE, notebookFile: 'apps/my app.py' }, 'uv-script-pins');

		it('layers pyproject first, then exports and installs the script pins', () => {
			expect(plan.setup).toHaveLength(4);
			const [
				{ command: pyproject },
				{ command: ensureEnv },
				{ command: exportCmd },
				{ command: installCmd },
			] = plan.setup;
			expect(pyproject).toContain('uv sync --inexact');
			expect(ensureEnv).toContain('uv venv');
			expect(exportCmd).toContain("uv export --script 'apps/my app.py'");
			expect(exportCmd).toContain('--format requirements-txt');
			expect(exportCmd).toContain('--prune marimo');
			expect(installCmd).toContain('uv pip install');
			// The env `uv run --no-sync` resolves — never VIRTUAL_ENV, which uv run
			// ignores and would leave the pins invisible to the kernel.
			expect(installCmd).toContain('--python "${UV_PROJECT_ENVIRONMENT:-.venv}"');
			expect(pyproject).not.toContain('--no-build');
			expect(plan.start).toMatch(/^uv run --no-sync marimo /);
		});

		it('writes the requirements file inside the pin env', () => {
			// Per-sandbox and lifecycle-managed on every backend — nothing left on a
			// shared host /tmp, no clobbering between concurrent local launches.
			const [, , { command: exportCmd }, { command: installCmd }] = plan.setup;
			const [, exportTarget] = /-o (\S+)/.exec(exportCmd) ?? [];
			expect(exportTarget).toBe(
				'"${UV_PROJECT_ENVIRONMENT:-.venv}/marimohub-script-requirements.txt"',
			);
			expect(installCmd).toContain(`-r ${exportTarget}`);
		});

		it('keeps every environment setup layer strict', () => {
			for (const { command } of plan.setup) expect(command).not.toContain('|| true');
		});

		it('reuses the exact uv-sync-edit pyproject layer', () => {
			expect(plan.setup[0].command).toBe(buildMarimoLaunch(BASE, 'uv-sync-edit').setup[0].command);
		});

		it('installs the pins in app mode too (setup is mode-invariant)', () => {
			const app = buildMarimoLaunch(
				{ ...BASE, notebookFile: 'apps/my app.py', mode: 'app' },
				'uv-script-pins',
			);
			expect(app.setup).toEqual(plan.setup);
		});

		it('shell-quotes a hostile notebook filename in the export command', () => {
			// Filenames come from synced repos and ride a single `&&`-joined shell string.
			const hostile = buildMarimoLaunch(
				{ ...BASE, notebookFile: "apps/it's a && b.py" },
				'uv-script-pins',
			);
			expect(hostile.setup[2].command).toContain(`--script 'apps/it'\\''s a && b.py'`);
		});
	});
});

describe('buildMarimoLaunch argument quoting', () => {
	const BASE: MarimoLaunchParams = {
		notebookFile: 'notebook.py',
		port: 2718,
		host: '0.0.0.0',
		tokenPasswordFile: '/tmp/.marimohub-kernel-token',
	};

	it('escapes command substitution in --asset-url', () => {
		const { start } = buildMarimoLaunch({
			...BASE,
			assetUrl: 'https://cdn.example.com/$(id > /tmp/pwned)',
		});
		expect(start).toContain("--asset-url='https://cdn.example.com/$(id > /tmp/pwned)'");
	});

	it('escapes a double quote in --base-url', () => {
		const { start } = buildMarimoLaunch({ ...BASE, baseUrl: '/proxy/a"; touch /tmp/pwned; #' });
		expect(start).toContain(`--base-url='/proxy/a"; touch /tmp/pwned; #'`);
	});
});

describe('hub-side pyproject inspection', () => {
	it.each([
		'project = false',
		'project = "invalid"',
		'project = []',
		'project = 2026-01-01',
		'[project]\ndependencies = "pandas"',
		'[project]\ndependencies = false',
		'[project]\ndependencies = ["pandas"]',
		'[project]\ndependencies = [',
		'\uFEFF[project]\ndependencies = []',
	])('leaves questionable manifests to sandbox validation: %s', (content) => {
		expect(preparePyproject(content)).toEqual({ content, skipSetup: false });
	});
	it.each([
		'[project]\nname = "example"\ndependencies = []\n# keep this comment\n',
		'project.dependencies = []\n',
	])('preserves dependency-free source text: %s', (content) => {
		expect(preparePyproject(content)).toEqual({ content, skipSetup: true });
	});
});
