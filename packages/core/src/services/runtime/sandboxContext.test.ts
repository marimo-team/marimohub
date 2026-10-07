import { exec as execCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { createSandboxId } from '../../ids';
import { makeFakeSandbox } from '../../testing/fakes';
import {
	buildSandboxContext,
	SANDBOX_CONTEXT_COMMAND_MARKER,
	sandboxContextFile,
	sandboxContextPath,
	writeSandboxContext,
} from './sandboxContext';
import type { SandboxContext } from './sandboxContext';

const exec = promisify(execCallback);
const context: SandboxContext = {
	schema_version: 1,
	public_url: 'https://user:password@sandbox.example/view/?access_token=secret#fragment',
	notebook_url: 'https://hub.example/projects/p/notebooks/n',
	exposure_mode: 'subdomain',
	persistence_mode: 'source',
	session_mode: 'edit',
};

async function filesystemSandbox(
	onTestFinished: TestContext['onTestFinished'],
	options: { cwd?: string } = {},
) {
	const root = await mkdtemp(join(tmpdir(), "workspace's root "));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	const { instance, calls } = makeFakeSandbox();
	instance.resolveProcessPath = (path) => join(root, path);
	const run = vi.spyOn(instance, 'exec').mockImplementation(async (command) => {
		try {
			return {
				success: true,
				...(await exec(command.replaceAll('/workspace', '/rewritten-workspace'), {
					cwd: options.cwd,
				})),
			};
		} catch {
			return { success: false, stdout: '', stderr: '', error: { code: 'COMMAND_FAILED' } };
		}
	});
	const id = createSandboxId();
	return { instance, calls, run, id, path: instance.resolveProcessPath(sandboxContextPath(id)) };
}

describe('buildSandboxContext', () => {
	const session = { project_id: 'p', notebook_id: 'n' } as const;

	it('versions the document and points at the notebook under the app base path', () => {
		const built = buildSandboxContext({
			session: session as never,
			sessionMode: 'app',
			appBaseUrl: 'https://hub.example/prefix/',
			publicUrl: 'https://sandbox.example/',
			exposureMode: 'proxy',
			persistence: 'none',
		});
		expect(built).toEqual({
			schema_version: 1,
			public_url: 'https://sandbox.example/',
			notebook_url: 'https://hub.example/prefix/projects/p/notebooks/n',
			exposure_mode: 'proxy',
			persistence_mode: 'none',
			session_mode: 'app',
		});
		const document = JSON.parse(sandboxContextFile(createSandboxId(), built).content) as object;
		expect(Object.keys(document)[0]).toBe('schema_version');
	});

	it('points a preview session at its preview resource', () => {
		const built = buildSandboxContext({
			session: { ...session, origin: { notebook_id: 'n', preview_id: 'pv' } } as never,
			sessionMode: 'edit',
			appBaseUrl: 'https://hub.example',
			publicUrl: 'https://sandbox.example/',
			exposureMode: 'subdomain',
			persistence: 'source',
		});
		expect(built.notebook_url).toBe('https://hub.example/projects/p/notebooks/n/previews/pv');
	});
});

describe('sandboxContextFile', () => {
	it.each([
		['https://sandbox.example', 'https://sandbox.example/'],
		[context.public_url, 'https://sandbox.example/view/'],
		[
			'https://sandbox.example/a%20view/?access_token=first&access_token=second&%61ccess_token=third&other=value#secret',
			'https://sandbox.example/a%20view/',
		],
		[
			'https://hub.example/prefix/proxy/signed.route/',
			'https://hub.example/prefix/proxy/signed.route/',
		],
		['http://[::1]:2718/view/?access_token=secret', 'http://[::1]:2718/view/'],
	])('preserves the public endpoint and strips credentials from %s', (publicUrl, expected) => {
		const file = sandboxContextFile(createSandboxId(), { ...context, public_url: publicUrl });
		expect(JSON.parse(file.content)).toEqual({ ...context, public_url: expected });
	});
});

describe('writeSandboxContext', () => {
	it('rejects a malformed URL before any sandbox call', async () => {
		const { instance, calls } = makeFakeSandbox();
		await expect(
			writeSandboxContext(instance, createSandboxId(), { ...context, public_url: 'not a URL' }),
		).rejects.toThrow();
		expect(calls.writeFiles).toEqual([]);
		expect(calls.exec).toEqual([]);
	});

	it('writes and renames in one call, with literal JSON and process-visible paths', async ({
		onTestFinished,
	}) => {
		const { instance, calls, run, id, path } = await filesystemSandbox(onTestFinished);
		const value = {
			...context,
			notebook_url:
				"https://hub.example/workspace/it's/$HOME/$(echo injected)/`echo injected`/日本語",
		};
		await writeSandboxContext(instance, id, value);
		expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
			...value,
			public_url: 'https://sandbox.example/view/',
		});
		await expect(readFile(`${path}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(run).toHaveBeenCalledOnce();
		expect(calls.writeFiles).toEqual([]);
	});

	it('leaves the published file unchanged if writing the temporary file fails', async ({
		onTestFinished,
	}) => {
		const { instance, id, path } = await filesystemSandbox(onTestFinished);
		await mkdir(`${path}.tmp`, { recursive: true });
		await writeFile(path, 'previous context');
		await expect(writeSandboxContext(instance, id, context)).rejects.toThrow(
			'Failed to publish sandbox context',
		);
		expect(await readFile(path, 'utf8')).toBe('previous context');
	});

	it.each([
		['permission denied', 'permission denied'],
		['/bin/sh: python3: not found\n', '/bin/sh: python3: not found'],
		[' \n\t', ''],
		[
			`${'x'.repeat(3000)}\nPermissionError: context is read-only\n`,
			`${'x'.repeat(1962)}\nPermissionError: context is read-only`,
		],
	])('reports bounded command diagnostics for %j', async (stderr, detail) => {
		const { instance } = makeFakeSandbox();
		vi.spyOn(instance, 'exec').mockResolvedValue({
			success: false,
			stdout: '',
			stderr,
			error: { code: 'COMMAND_FAILED' },
		});
		await expect(writeSandboxContext(instance, createSandboxId(), context)).rejects.toMatchObject({
			message: detail
				? `Failed to publish sandbox context: ${detail}`
				: 'Failed to publish sandbox context',
		});
	});

	it('runs Python in isolated mode so workspace modules cannot shadow the standard library', async ({
		onTestFinished,
	}) => {
		// vitest workers cannot chdir, so the shadowing module goes in the exec cwd instead.
		const workspace = await mkdtemp(join(tmpdir(), 'shadowing-cwd-'));
		onTestFinished(() => rm(workspace, { recursive: true, force: true }));
		await writeFile(join(workspace, 'base64.py'), 'raise SystemExit("shadowed")\n');
		const { instance, run, id, path } = await filesystemSandbox(onTestFinished, { cwd: workspace });
		await writeSandboxContext(instance, id, context);
		expect(String(run.mock.calls[0]?.[0])).toMatch(/^python3 -I -c /);
		expect(String(run.mock.calls[0]?.[0])).toContain(SANDBOX_CONTEXT_COMMAND_MARKER);
		expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ schema_version: 1 });
	});

	it('times out a hung publication', async () => {
		vi.useFakeTimers();
		try {
			const { instance } = makeFakeSandbox();
			vi.spyOn(instance, 'exec').mockReturnValue(new Promise(() => {}));
			const pending = writeSandboxContext(instance, createSandboxId(), context);
			const assertion = expect(pending).rejects.toThrow('Publishing sandbox context timed out');
			await vi.advanceTimersByTimeAsync(15_000);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});

	it('preserves transport failures', async () => {
		const { instance } = makeFakeSandbox();
		const error = new Error('connection lost');
		vi.spyOn(instance, 'exec').mockRejectedValue(error);
		await expect(writeSandboxContext(instance, createSandboxId(), context)).rejects.toBe(error);
	});
});
