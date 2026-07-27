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
});
