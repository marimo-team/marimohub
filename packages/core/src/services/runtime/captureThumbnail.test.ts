import { afterEach, describe, expect, it, vi } from 'vitest';
import * as logs from '../../logs';
import { captureThumbnail } from './captureThumbnail';
import { ACTOR, setupTestEnv } from '../../testing';
import { thumbnailPng } from '../../testing/thumbnail';
import { makeFakeSandbox } from '../../testing/fakes';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
async function setup() {
	const env = await setupTestEnv();
	const p = await env.projects.createProject({ name: 'P', description: '' }, ACTOR);
	const n = await env.notebooks.createNotebook(
		p.id,
		{ title: 'N', description: '', code: 'x = 1' },
		ACTOR,
	);
	await env.notebooks.commitSession(p.id, n.id, { code: 'x = 1', html: '<div>saved</div>' }, ACTOR);
	return { ...env, pid: p.id, nid: n.id };
}
describe('shutdown capture', () => {
	it.each(['missing_playwright', 'missing_chromium', 'render_failed', 'timeout'])(
		'preserves the fallback on %s',
		async (status) => {
			const { notebooks, pid, nid } = await setup();
			const sandbox = makeFakeSandbox().instance;
			vi.spyOn(sandbox, 'exec').mockResolvedValue({
				success: true,
				stdout: JSON.stringify({ status }),
				stderr: '',
			});
			await captureThumbnail(sandbox, notebooks, pid, nid, 'sandbox');
			expect((await notebooks.thumbnails.metadata(pid, nid)).source).toBeNull();
			await captureThumbnail(sandbox, notebooks, pid, nid, 'sandbox');
			expect(sandbox.exec).toHaveBeenCalledTimes(1);
		},
	);
	it('makes one attempt for concurrent shutdown calls and skips unchanged HTML thereafter', async () => {
		const { notebooks, pid, nid } = await setup();
		const sandbox = makeFakeSandbox().instance;
		const exec = vi.spyOn(sandbox, 'exec').mockResolvedValue({
			success: true,
			stdout: JSON.stringify({ status: 'ok', png: btoa(String.fromCharCode(...thumbnailPng())) }),
			stderr: '',
		});
		await Promise.all([
			captureThumbnail(sandbox, notebooks, pid, nid, 'same'),
			captureThumbnail(sandbox, notebooks, pid, nid, 'same'),
		]);
		expect(exec).toHaveBeenCalledTimes(1);
		await captureThumbnail(sandbox, notebooks, pid, nid, 'next');
		expect(exec).toHaveBeenCalledTimes(1);
	});
	it('skips custom thumbnails and missing HTML without executing anything', async () => {
		const { notebooks, pid, nid } = await setup();
		const sandbox = makeFakeSandbox().instance;
		const exec = vi.spyOn(sandbox, 'exec');
		await notebooks.thumbnails.setCustom(pid, nid, thumbnailPng());
		await captureThumbnail(sandbox, notebooks, pid, nid, 'custom');
		await notebooks.thumbnails.removeCustom(pid, nid);
		vi.spyOn(notebooks, 'getVersionHtmlSnapshot').mockResolvedValue(null);
		await captureThumbnail(sandbox, notebooks, pid, nid, 'missing');
		expect(exec).not.toHaveBeenCalled();
	});
	it('preserves the previous successful image when updated HTML cannot render', async () => {
		const { notebooks, pid, nid } = await setup();
		const capture = (await notebooks.thumbnails.prepare(pid, nid))!;
		await notebooks.thumbnails.publish(pid, nid, capture, thumbnailPng());
		const previous = await notebooks.thumbnails.metadata(pid, nid);
		await notebooks.commitSession(pid, nid, { code: 'x = 2', html: '<div>changed</div>' }, ACTOR);
		const sandbox = makeFakeSandbox().instance;
		vi.spyOn(sandbox, 'exec').mockResolvedValue({
			success: true,
			stdout: JSON.stringify({ status: 'render_failed' }),
			stderr: '',
		});
		await captureThumbnail(sandbox, notebooks, pid, nid, 'failed');
		expect(await notebooks.thumbnails.metadata(pid, nid)).toEqual(previous);
	});

	it('does not start a browser without enough shutdown time', async () => {
		const { notebooks, pid, nid } = await setup();
		const sandbox = makeFakeSandbox().instance;
		const exec = vi.spyOn(sandbox, 'exec');
		await captureThumbnail(sandbox, notebooks, pid, nid, 'sandbox', '/workspace', Date.now() + 100);
		expect(exec).not.toHaveBeenCalled();
	});
	it.each(['prepare', 'exec'] as const)(
		'returns at the deadline and ignores late %s completion',
		async (stage) => {
			const { notebooks, pid, nid } = await setup();
			const capture = (await notebooks.thumbnails.prepare(pid, nid))!;
			const sandbox = makeFakeSandbox().instance;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const exec = vi.spyOn(sandbox, 'exec').mockImplementation(async () => {
				entered.resolve();
				await release.promise;
				return {
					success: true,
					stdout: JSON.stringify({
						status: 'ok',
						png: btoa(String.fromCharCode(...thumbnailPng())),
					}),
					stderr: '',
				};
			});
			if (stage === 'prepare')
				vi.spyOn(notebooks.thumbnails, 'prepare').mockImplementation(async () => {
					entered.resolve();
					await release.promise;
					return capture;
				});
			const publish = vi.spyOn(notebooks.thumbnails, 'publish');
			vi.useFakeTimers();
			const pending = captureThumbnail(
				sandbox,
				notebooks,
				pid,
				nid,
				'deadline',
				'/workspace',
				Date.now() + 2000,
			);
			await entered.promise;
			await vi.advanceTimersByTimeAsync(2000);
			await pending;
			release.resolve();
			await vi.runAllTimersAsync();
			expect(publish).not.toHaveBeenCalled();
			expect(exec).toHaveBeenCalledTimes(stage === 'prepare' ? 0 : 1);
			if (stage === 'exec') expect(exec.mock.calls[0][1]!.timeout).toBeLessThanOrEqual(2000);
		},
	);
	it.each(['not JSON', 'null', '{"status":"ok","png":"%%%"}', '{"status":"ok","png":42}'])(
		'ignores malformed renderer output: %s',
		async (stdout) => {
			const { notebooks, pid, nid } = await setup();
			const sandbox = makeFakeSandbox().instance;
			vi.spyOn(sandbox, 'exec').mockResolvedValue({ success: true, stdout, stderr: '' });
			await expect(
				captureThumbnail(sandbox, notebooks, pid, nid, 'malformed'),
			).resolves.toBeUndefined();
			expect(await notebooks.thumbnails.get(pid, nid)).toBeNull();
		},
	);

	it('logs one sanitized outcome for unexpected renderer status data', async () => {
		const { notebooks, pid, nid } = await setup();
		const sandbox = makeFakeSandbox().instance;
		vi.spyOn(sandbox, 'exec').mockResolvedValue({
			success: true,
			stdout: JSON.stringify({ status: { detail: 'private sandbox output' } }),
			stderr: '',
		});
		const log = vi.spyOn(logs, 'logEvent');
		await captureThumbnail(sandbox, notebooks, pid, nid, 'unexpected');
		expect(log).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ event: 'thumbnail_capture', outcome: 'failed' }),
		);
		expect(JSON.stringify(log.mock.calls)).not.toContain('private sandbox output');
	});

	it('publishes PNG bytes from saved HTML and does not execute notebook code', async () => {
		const { notebooks, pid, nid } = await setup();
		const sandbox = makeFakeSandbox().instance;
		vi.spyOn(sandbox, 'exec').mockResolvedValue({
			success: true,
			stdout: JSON.stringify({ status: 'ok', png: btoa(String.fromCharCode(...thumbnailPng())) }),
			stderr: '',
		});
		await captureThumbnail(sandbox, notebooks, pid, nid, 'sandbox');
		expect((await notebooks.thumbnails.metadata(pid, nid)).source).toBe('automatic');
		expect(sandbox.exec).toHaveBeenCalledWith(
			expect.not.stringContaining('marimo export'),
			expect.objectContaining({ timeout: expect.any(Number) }),
		);
	});
});
