import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { ApplyError, createHub, integration } from './index';

const spec = integration('postgres', 'db', {
	host: 'db',
	database: 'db',
	username: 'user',
	password: 'private-password',
});
const planned = {
	name: 'db',
	kind: 'postgres',
	action: 'create',
	changed_paths: ['config'],
	precondition: { state: 'absent' },
	org_override: false,
};
const outcome = {
	name: 'db',
	kind: 'postgres',
	id: 'intg-test',
	action: 'created',
	current_version: 1,
	config_changed: true,
};
const ok = (data: unknown) => Response.json({ success: true, data });

describe('IaC SDK', () => {
	it('uses prefix-aware URLs, bearer auth, no redirects and secret-free plans', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(ok(planned))
			.mockResolvedValueOnce(ok(outcome));
		const target = createHub({
			url: 'https://hub.example/prefix/',
			token: 'private-token',
			fetch,
		}).project('p').integrations;
		const plan = await target.plan([spec]);
		expect(String(fetch.mock.calls[0][0])).toBe(
			'https://hub.example/prefix/api/v1/projects/p/integrations/reconcile/plan',
		);
		expect(fetch.mock.calls[0][1]).toMatchObject({
			redirect: 'error',
			headers: { Authorization: 'Bearer private-token' },
		});
		expect(JSON.stringify(plan)).not.toContain('private');
		expect(inspect(plan)).not.toContain('private');
		expect((await target.apply(plan)).completed).toEqual([outcome]);
	});
	it('does not write when preflight fails and rejects duplicate names locally', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(ok(planned))
			.mockResolvedValueOnce(Response.json({ error: 'private-password' }, { status: 422 }));
		const target = createHub({ url: 'https://hub.example', token: 't', fetch }).project(
			'p',
		).integrations;
		await expect(target.plan([spec, { ...spec, name: 'other' }])).rejects.toMatchObject({
			code: 'VALIDATION_ERROR',
		});
		expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/plan'))).toBe(true);
		await expect(target.plan([spec, spec])).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it('reports partial success without retrying a reviewed stale apply', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(ok(planned))
			.mockResolvedValueOnce(ok({ ...planned, name: 'second' }))
			.mockResolvedValueOnce(ok({ ...planned, name: 'third' }))
			.mockResolvedValueOnce(ok(outcome))
			.mockResolvedValueOnce(new Response(null, { status: 412 }));
		const target = createHub({ url: 'https://hub.example', token: 't', fetch }).project(
			'p',
		).integrations;
		const plan = await target.plan([spec, { ...spec, name: 'second' }, { ...spec, name: 'third' }]);
		await expect(target.apply(plan)).rejects.toMatchObject({
			report: {
				completed: [outcome],
				failed: { name: 'second', code: 'PRECONDITION_FAILED', uncertain: false },
				notAttempted: [{ name: 'third', kind: 'postgres' }],
			},
		});
		expect(fetch).toHaveBeenCalledTimes(5);
	});
	it('reconciles an uncertain upsert but never replays strict insert', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(ok(planned))
			.mockRejectedValueOnce(new Error('private-password'))
			.mockResolvedValueOnce(
				ok({
					...planned,
					action: 'unchanged',
					precondition: { state: 'existing', id: 'i', revision: 'r' },
				}),
			)
			.mockResolvedValueOnce(ok({ ...outcome, action: 'unchanged' }));
		const target = createHub({ url: 'https://hub.example', token: 't', fetch }).project(
			'p',
		).integrations;
		expect(await target.upsert(spec)).toMatchObject({ action: 'converged' });
		fetch.mockResolvedValueOnce(ok(planned)).mockRejectedValueOnce(new Error('private-token'));
		await expect(target.insert(spec)).rejects.toMatchObject({ uncertain: true });
		expect(fetch).toHaveBeenCalledTimes(6);
	});
	it('bounds a hanging token callback and handles pre-aborted calls', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const target = createHub({
			url: 'https://hub.example',
			token: () => new Promise<string>(() => {}),
			timeoutMs: 20,
			fetch,
		}).project('p').integrations;
		await expect(target.plan([spec])).rejects.toMatchObject({ code: 'ABORTED' });
		await expect(target.plan([spec], { signal: AbortSignal.abort() })).rejects.toMatchObject({
			code: 'ABORTED',
		});
		expect(fetch).not.toHaveBeenCalled();
	});
	it('does not expose token callback failures or apply foreign plans', async () => {
		const failure = createHub({
			url: 'https://hub.example',
			token: () => {
				throw new Error('private-token');
			},
		}).project('p').integrations;
		await expect(failure.plan([spec])).rejects.toThrow('Unable to obtain a Hub token.');
		const hub = createHub({
			url: 'https://hub.example',
			token: 't',
			fetch: vi.fn().mockResolvedValue(ok(planned)),
		});
		const plan = await hub.project('p').integrations.plan([spec]);
		await expect(hub.project('q').integrations.apply(plan)).rejects.toMatchObject({
			code: 'INVALID_PLAN',
		});
		expect(ApplyError.prototype).toBeInstanceOf(Error);
	});
});
