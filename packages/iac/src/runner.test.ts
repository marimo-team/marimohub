import { afterEach, expect, it, vi } from 'vitest';
import { runIntegrations } from './runner';
import { integration } from './index';

const spec = integration('agent_context', 'context', { instructions: 'Use polars.' });
const planned = {
	name: 'context',
	kind: 'agent_context',
	action: 'create',
	changed_paths: ['config'],
	precondition: { state: 'absent' },
	org_override: false,
};
const vars: Record<string, string> = {
	MARIMOHUB_URL: 'https://hub.example',
	MARIMOHUB_TOKEN: 't',
	MARIMOHUB_PROJECT_ID: 'p',
};
const environment = () => ({ get: (key: string) => vars[key], out: vi.fn(), err: vi.fn() });
afterEach(() => vi.unstubAllGlobals());

it('returns drift status without applying and emits JSON without diagnostics', async () => {
	const fetch = vi.fn().mockResolvedValue(Response.json({ success: true, data: planned }));
	vi.stubGlobal('fetch', fetch);
	const env = environment();
	expect(await runIntegrations([spec], env, ['--check', '--json'])).toBe(2);
	expect(JSON.parse(env.out.mock.calls[0][0])).toEqual({ items: [planned] });
	expect(env.err).not.toHaveBeenCalled();
	expect(fetch).toHaveBeenCalledTimes(1);
});
it('returns zero for valid plan and no-drift check', async () => {
	vi.stubGlobal(
		'fetch',
		vi
			.fn()
			.mockImplementation(async () =>
				Response.json({ success: true, data: { ...planned, action: 'unchanged' } }),
			),
	);
	expect(await runIntegrations([spec], environment(), ['--plan'])).toBe(0);
	expect(await runIntegrations([spec], environment(), ['--check'])).toBe(0);
});
it('uses stderr for diagnostics and returns one on failure', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue(new Response('private-provider-detail', { status: 403 })),
	);
	const env = environment();
	expect(await runIntegrations([spec], env, ['--json'])).toBe(1);
	expect(env.err).toHaveBeenCalledOnce();
	expect(JSON.parse(env.out.mock.calls[0][0])).toHaveProperty('error');
	expect(JSON.stringify(env.out.mock.calls)).not.toContain('private-provider-detail');
});

it.each(['MARIMOHUB_URL', 'MARIMOHUB_TOKEN', 'MARIMOHUB_PROJECT_ID'])(
	'reports missing %s without requesting the Hub',
	async (missing) => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		const env = {
			...environment(),
			get: (key: string) => (key === missing ? undefined : vars[key]),
		};
		expect(await runIntegrations([spec], env, ['--json'])).toBe(1);
		expect(JSON.parse(env.out.mock.calls[0][0])).toEqual({
			error: `Missing environment variable: ${missing}`,
		});
		expect(fetch).not.toHaveBeenCalled();
	},
);
it.each([{ args: ['--plan', '--check'] }, { args: ['--private-token'] }, { args: ['--apply'] }])(
	'rejects invalid flags %j before fetching',
	async ({ args }) => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		const env = environment();
		expect(await runIntegrations([spec], env, [...args, '--json'])).toBe(1);
		expect(JSON.stringify(env.out.mock.calls)).not.toContain('private-token');
		expect(fetch).not.toHaveBeenCalled();
	},
);
it('emits safe partial JSON after an uncertain apply and leaves later declarations untouched', async () => {
	const completed = {
		name: 'context',
		kind: 'agent_context',
		id: 'i',
		action: 'created',
		current_version: 1,
		config_changed: true,
	};
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json({ success: true, data: planned }))
		.mockResolvedValueOnce(Response.json({ success: true, data: { ...planned, name: 'second' } }))
		.mockResolvedValueOnce(Response.json({ success: true, data: { ...planned, name: 'third' } }))
		.mockResolvedValueOnce(
			Response.json({ success: true, data: { ...completed, config: 'private-config' } }),
		)
		.mockRejectedValueOnce(new Error('private-provider'));
	vi.stubGlobal('fetch', fetch);
	const env = environment();
	expect(
		await runIntegrations([spec, { ...spec, name: 'second' }, { ...spec, name: 'third' }], env, [
			'--json',
		]),
	).toBe(1);
	expect(JSON.parse(env.out.mock.calls[0][0])).toEqual({
		completed: [completed],
		failed: { name: 'second', kind: spec.kind, code: 'NETWORK_ERROR', uncertain: true },
		notAttempted: [{ name: 'third', kind: spec.kind }],
	});
	expect(JSON.stringify([env.out.mock.calls, env.err.mock.calls])).not.toContain('private');
	expect(fetch).toHaveBeenCalledTimes(5);
});
