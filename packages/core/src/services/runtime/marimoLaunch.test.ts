import { describe, expect, it } from 'vitest';
import { buildMarimoLaunch, MARIMO_LAUNCH_STRATEGIES } from './marimoLaunch';
import type { MarimoLaunchParams } from './marimoLaunch';

const BASE: MarimoLaunchParams = {
	notebookFile: 'notebook.py',
	port: 2718,
	host: '0.0.0.0',
	assetUrl: 'https://cdn.example.com/assets',
	baseUrl: '/proxy/tok',
};

describe('buildMarimoLaunch', () => {
	it('defaults to edit mode', () => {
		const { start } = buildMarimoLaunch(BASE);
		expect(start).toContain('marimo edit');
		expect(start).not.toContain('marimo run');
	});

	it('edit keeps --convert and --asset-url', () => {
		const { start } = buildMarimoLaunch({ ...BASE, mode: 'edit' });
		expect(start).toContain('--convert');
		expect(start).toContain('--asset-url="https://cdn.example.com/assets"');
		expect(start).toContain('--base-url="/proxy/tok"');
	});

	// --convert's fallback can rewrite a file as Python, so it must never reach a
	// markdown-family notebook.
	for (const file of ['docs/page.md', 'page.markdown', 'reports/q3.qmd']) {
		it(`edit drops --convert for ${file}`, () => {
			const { start } = buildMarimoLaunch({ ...BASE, mode: 'edit', notebookFile: file });
			expect(start).toContain('marimo edit');
			expect(start).not.toContain('--convert');
		});
	}

	it('edit keeps --convert for a nested .py entry (synced sources set entryNotebook)', () => {
		const { start } = buildMarimoLaunch({ ...BASE, mode: 'edit', notebookFile: 'apps/main.py' });
		expect(start).toContain('--convert');
	});

	it('app drops --convert but keeps host/port/asset-url/base-url', () => {
		const { start } = buildMarimoLaunch({ ...BASE, mode: 'app' });
		expect(start).toContain('marimo run');
		expect(start).not.toContain('--convert');
		expect(start).toContain('--headless --no-token --host 0.0.0.0 --port 2718');
		// A hidden-but-real option on `marimo run` — the CDN fast path applies to apps.
		expect(start).toContain('--asset-url="https://cdn.example.com/assets"');
		expect(start).toContain('--base-url="/proxy/tok"');
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

	// Every strategy must honor the mode — a new strategy hardcoding `marimo
	// edit` would silently break app sessions.
	for (const [name, strategy] of Object.entries(MARIMO_LAUNCH_STRATEGIES)) {
		it(`strategy ${name} emits the mode's subcommand`, () => {
			expect(strategy({ ...BASE, mode: 'edit' }).start).toContain('marimo edit');
			expect(strategy({ ...BASE, mode: 'app' }).start).toContain('marimo run');
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
			expect(installCmd).toContain('--no-build');
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
