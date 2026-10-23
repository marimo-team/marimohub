import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import {
	assembleMarimoToml,
	marimoConfigToSessionEnv,
	marimoNotebookDefaults,
	marimoSharingDisabled,
	prepareMarimoPresentation,
	serializeMarimoToml,
} from './marimoConfig';
import type { MarimoConfigContributor } from './marimoConfig';

describe('serializeMarimoToml', () => {
	it('round-trips nested tables and arrays', () => {
		const config = {
			ai: {
				enabled: true,
				max_tokens: 512,
				model_order: ['chat', 'edit'],
				models: { chat_model: 'x/y' },
				custom_providers: { x: { base_url: 'u' } },
			},
		};
		expect(parse(serializeMarimoToml(config))).toEqual(config);
	});

	it('quotes keys and escapes every control character', () => {
		const config = {
			'section.with.dots': {
				'quoted"key': Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)).join(''),
			},
		};
		expect(parse(serializeMarimoToml(config))).toEqual(config);
	});

	it('is empty for an empty config', () => {
		expect(serializeMarimoToml({})).toBe('');
	});
});

describe('assembleMarimoToml', () => {
	it('starts empty — no contributors yields no config', () => {
		expect(assembleMarimoToml([])).toBe('');
	});

	it('treats an empty-table contributor as a no-op', () => {
		const nothing: MarimoConfigContributor = () => ({});
		expect(assembleMarimoToml([nothing, marimoNotebookDefaults])).toBe(
			assembleMarimoToml([marimoNotebookDefaults]),
		);
	});

	it('deep-merges overlapping sections from multiple contributors', () => {
		const a: MarimoConfigContributor = () => ({ display: { default_width: 'medium' } });
		const b: MarimoConfigContributor = () => ({ display: { theme: 'dark' } });
		expect(parse(assembleMarimoToml([a, b]))).toEqual({
			display: { default_width: 'medium', theme: 'dark' },
		});
	});

	it('later contributors win a scalar collision', () => {
		const a: MarimoConfigContributor = () => ({ display: { default_width: 'medium' } });
		const b: MarimoConfigContributor = () => ({ display: { default_width: 'full' } });
		expect(parse(assembleMarimoToml([a, b]))).toEqual({
			display: { default_width: 'full' },
		});
	});

	it('later contributors win table-scalar collisions in either direction', () => {
		const table: MarimoConfigContributor = () => ({ feature: { enabled: true } });
		const scalar: MarimoConfigContributor = () => ({ feature: 'disabled' });

		expect(parse(assembleMarimoToml([table, scalar]))).toEqual({ feature: 'disabled' });
		expect(parse(assembleMarimoToml([scalar, table]))).toEqual({
			feature: { enabled: true },
		});
	});

	it('does not mutate fragments while merging them', () => {
		const fragment = { display: { default_width: 'medium' } };
		const first: MarimoConfigContributor = () => fragment;
		const second: MarimoConfigContributor = () => ({ display: { theme: 'dark' } });

		assembleMarimoToml([first, second]);

		expect(fragment).toEqual({ display: { default_width: 'medium' } });
	});
});

describe('marimoNotebookDefaults', () => {
	it('sets medium width and native SQL output', () => {
		expect(parse(assembleMarimoToml([marimoNotebookDefaults]))).toEqual({
			display: { default_width: 'medium' },
			runtime: { default_sql_output: 'native' },
		});
	});
});

describe('marimoSharingDisabled', () => {
	it('turns off every sharing surface', () => {
		expect(parse(assembleMarimoToml([marimoSharingDisabled]))).toEqual({
			sharing: { html: false, wasm: false, molab: false },
		});
	});
});

describe('marimoConfigToSessionEnv', () => {
	it('writes marimo.toml under the injected XDG_CONFIG_HOME', () => {
		const env = marimoConfigToSessionEnv([marimoNotebookDefaults]);
		expect(env.vars).toEqual({ XDG_CONFIG_HOME: '/tmp/marimohub-config' });
		expect(env.defaults).toEqual({
			XDG_CACHE_HOME: '/tmp/marimohub-cache',
			XDG_STATE_HOME: '/tmp/marimohub-state',
		});
		expect(env.files).toHaveLength(1);
		const [file] = env.files ?? [];
		expect(file?.path).toBe('/tmp/marimohub-config/marimo/marimo.toml');
		expect(parse(file?.content ?? '')).toEqual({
			display: { default_width: 'medium' },
			runtime: { default_sql_output: 'native' },
		});
	});
});

describe('prepareMarimoPresentation', () => {
	const resolve = (path: string) => `/local-sandbox${path}`;
	const configPath = '/tmp/marimohub-config/marimo/marimo.toml';
	const cssPath = '/tmp/marimohub-integrations/presentation/theme.css';
	const headPath = '/tmp/marimohub-integrations/presentation/head.html';
	const headEnv = '_MARIMO_APP_OVERLOAD_HTML_HEAD_FILE';

	it('merges CSS with editor policy and AI configuration and maps process paths', () => {
		const base = marimoConfigToSessionEnv([
			marimoNotebookDefaults,
			marimoSharingDisabled,
			() => ({ ai: { enabled: true, models: { chat_model: 'test-model' } } }),
		]);
		const result = prepareMarimoPresentation(
			{
				...base,
				marimoPresentation: { cssFiles: [cssPath], htmlHeadFile: headPath },
			},
			resolve,
			{ mode: 'edit' },
		)!;
		expect(result.files?.filter((file) => file.path === configPath)).toHaveLength(1);
		expect(parse(result.files!.find((file) => file.path === configPath)!.content)).toEqual({
			display: { default_width: 'medium', custom_css: [resolve(cssPath)] },
			runtime: { default_sql_output: 'native' },
			sharing: { html: false, wasm: false, molab: false },
			ai: { enabled: true, models: { chat_model: 'test-model' } },
		});
		expect(result.vars?.XDG_CONFIG_HOME).toBe(resolve('/tmp/marimohub-config'));
		expect(result.vars).not.toHaveProperty(headEnv);
		expect(base.files?.[0]?.content).not.toContain('custom_css');
	});

	it.each(['app', 'job'] as const)('sets native HTML head configuration for %s', (mode) => {
		const result = prepareMarimoPresentation(
			{
				marimoPresentation: { cssFiles: [cssPath], htmlHeadFile: headPath },
				files: [{ path: headPath, content: '<meta name="team">' }],
				vars: { KEEP: 'value' },
			},
			resolve,
			{ mode },
		)!;
		expect(result.vars).toMatchObject({ [headEnv]: resolve(headPath), KEEP: 'value' });
		expect(result.files).toContainEqual({ path: headPath, content: '<meta name="team">' });
		expect(parse(result.files!.find((file) => file.path === configPath)!.content)).toEqual({
			display: { custom_css: [resolve(cssPath)] },
		});
	});

	it('replaces stale snapshot configuration and clears the head override without suppressing notebook heads', () => {
		const result = prepareMarimoPresentation(undefined, resolve, { restored: true, mode: 'app' })!;
		expect(result.files).toEqual([{ path: configPath, content: '' }]);
		expect(result.vars?.[headEnv]).toBe('None');
	});

	it('does not add configuration to a fresh workload without presentation', () => {
		expect(prepareMarimoPresentation(undefined, resolve)).toBeUndefined();
	});

	it.each(['edit', 'app', 'job'] as const)(
		'keeps current CSS and clears an old head on a restored %s',
		(mode) => {
			const result = prepareMarimoPresentation(
				{
					...marimoConfigToSessionEnv([marimoSharingDisabled]),
					marimoPresentation: { cssFiles: [cssPath] },
					vars: { [headEnv]: '/old/head.html' },
				},
				resolve,
				{ restored: true, mode },
			)!;
			expect(result.vars?.[headEnv]).toBe('None');
			expect(parse(result.files!.find((file) => file.path === configPath)!.content)).toEqual({
				display: { custom_css: [resolve(cssPath)] },
				sharing: { html: false, wasm: false, molab: false },
			});
		},
	);

	it('round-trips mapped paths containing quotes, backslashes, whitespace, and Unicode', () => {
		const path = '/local/team "one"/back\\slash/é\n/theme.css';
		const result = prepareMarimoPresentation(
			{ marimoPresentation: { cssFiles: [cssPath] } },
			() => path,
		)!;
		expect(parse(result.files!.find((file) => file.path === configPath)!.content)).toEqual({
			display: { custom_css: [path] },
		});
	});

	it('does not mutate inputs or partially rewrite malformed configuration', () => {
		const env = {
			files: [{ path: configPath, content: '[display\n' }],
			marimoPresentation: { cssFiles: [cssPath] },
		};
		const original = structuredClone(env);
		expect(() => prepareMarimoPresentation(env, resolve)).toThrow();
		expect(env).toEqual(original);
	});
});
