import { expect, it } from 'vitest';
import { mergeAgentSettings } from './agentContext';
import { parseAgentJson } from './kinds/agentContext';

it('preserves explicit org disables and empty plugin lists', () => {
	const project = {
		plugin: ['project-plugin'],
		mcp: { shared: { command: ['project'] }, projectOnly: { enabled: true } },
		enabled: true,
		nested: { value: 'project', keep: true },
	};
	const org = { plugin: [], mcp: { shared: false }, enabled: false, nested: { value: null } };
	const before = structuredClone({ project, org });
	expect(mergeAgentSettings(project, org)).toEqual({
		plugin: [],
		mcp: { shared: false, projectOnly: { enabled: true } },
		enabled: false,
		nested: { value: null, keep: true },
	});
	expect({ project, org }).toEqual(before);
});

it('replaces an MCP server atomically instead of inheriting project commands and headers', () => {
	expect(
		mergeAgentSettings(
			{
				mcp: {
					shared: { command: ['project'], headers: { authorization: 'project' }, enabled: false },
				},
			},
			{ mcp: { shared: { type: 'remote', url: 'https://org.example' } } },
		),
	).toEqual({ mcp: { shared: { type: 'remote', url: 'https://org.example' } } });
});

it('handles prototype-like JSON keys without changing object prototypes', () => {
	const result = mergeAgentSettings(
		parseAgentJson(
			'{"__proto__":{"polluted":"project"},"constructor":{"prototype":{"polluted":"project"}}}',
		),
		parseAgentJson(
			'{"__proto__":{"polluted":"org"},"constructor":{"prototype":{"polluted":"org"}}}',
		),
	);
	expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	expect(Object.hasOwn(result, '__proto__')).toBe(true);
	expect(JSON.stringify(result)).toBe(
		'{"__proto__":{"polluted":"org"},"constructor":{"prototype":{"polluted":"org"}}}',
	);
	expect({}).not.toHaveProperty('polluted');
});
