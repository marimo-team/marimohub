import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import {
	assembleMarimoToml,
	marimoConfigToSessionEnv,
	marimoNotebookDefaults,
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

describe('marimoConfigToSessionEnv', () => {
	it('writes marimo.toml under XDG_CONFIG_HOME (trailing slash trimmed)', () => {
		const env = marimoConfigToSessionEnv('/opt/marimohub-config///', [marimoNotebookDefaults]);
		expect(env.vars.XDG_CONFIG_HOME).toBe('/opt/marimohub-config');
		expect(env.files).toHaveLength(1);
		expect(env.files[0].path).toBe('/opt/marimohub-config/marimo/marimo.toml');
		expect(parse(env.files[0].content)).toEqual({
			display: { default_width: 'medium' },
			runtime: { default_sql_output: 'native' },
		});
	});

	it.each(['', '/', 'relative/path'])('rejects invalid XDG config path %j', (path) => {
		expect(() => marimoConfigToSessionEnv(path, [])).toThrow(
			'XDG config path must be an absolute, non-root path',
		);
	});
});
